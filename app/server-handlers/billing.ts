import { setSessionContext } from '~/lib/.server/auth';
import {
  billingConfig,
  cancelSubscription,
  checkoutSubscription,
  createCheckout,
  createCustomer,
  createPortalSession,
  readSubscription,
  StripeError,
  verifiedEvent,
  type BillingConfig,
} from '~/lib/.server/billing/stripe';
import { findCloudflareConnectionForOrganization } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { readBodyBytesWithLimit } from '~/lib/bounded-body';
import { publicOrigin } from '~/lib/.server/public-origin';
import {
  applySubscription,
  claimStripeEvent,
  findManagedSubscription,
  givesSpace,
  recordCustomer,
  releaseStripeEvent,
  spaceUsage,
} from '~/lib/cloudflare/data/managed-subscriptions.server';
import { MANAGED_SPACE_MONTHLY_PRICE_USD, MANAGED_SPACE_TRIAL_DAYS } from '~/lib/managed-space';
import { prepareWorkspaceInBackground } from './cloudflare-integration';
import { signedIn } from './signed-in';

/**
 * Subscribing to a space CloudChef runs (`app/lib/cloudflare/data/managed-subscriptions.server.ts`):
 * what the plan is and where this person stands, Stripe's checkout and its portal, and the webhook
 * Stripe reports every change of a subscription to. The webhook is the record; the return from checkout
 * reads the same subscription itself so the person isn't kept waiting for it.
 */
export const BILLING_RETURN_PATH = '/api/billing/return';
const MAX_WEBHOOK_BYTES = 256 * 1024;
const UNAVAILABLE = 'A space CloudChef runs is not open yet.';

/** The managed team's connection while it is active: without it a subscription would buy nowhere to build. */
async function managedConnection(env: Env, config: BillingConfig) {
  const connection = await findCloudflareConnectionForOrganization(env.DB, config.managedOrgId);
  return connection?.status === 'active' ? connection : null;
}

/** `GET /api/billing`: the plan, whether it can be bought here, and this person's subscription and use. */
export function billingStatusAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const config = billingConfig(env);
    const connection = config ? await managedConnection(env, config) : null;
    const subscription = await findManagedSubscription(env.DB, session.user.id);
    const hasSpace = subscription !== null && givesSpace(subscription.status);
    return Response.json(
      {
        available: connection !== null,
        monthlyPriceUsd: MANAGED_SPACE_MONTHLY_PRICE_USD,
        // A first subscription starts with the plan's free days, when it has any; a later one doesn't.
        trialDays: subscription?.subscriptionId ? 0 : MANAGED_SPACE_TRIAL_DAYS,
        subscription:
          subscription && subscription.subscriptionId
            ? {
                status: subscription.status,
                hasSpace,
                trialEndsAt: subscription.trialEndsAt,
                currentPeriodEndsAt: subscription.currentPeriodEndsAt,
                cancelsAtPeriodEnd: subscription.cancelsAtPeriodEnd,
              }
            : null,
        usage:
          config && connection && hasSpace
            ? await spaceUsage(env.DB, connection.id, config.managedOrgId, session.user.id)
            : null,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  });
}

/** `POST /api/billing/checkout`: Stripe's page for the card, which returns to `BILLING_RETURN_PATH`. */
export function startCheckoutAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const config = billingConfig(env);
    if (!config || !(await managedConnection(env, config))) {
      return Response.json({ error: UNAVAILABLE }, { status: 503 });
    }
    const existing = await findManagedSubscription(env.DB, session.user.id);
    if (existing && givesSpace(existing.status)) {
      return Response.json({ error: 'You already have a space. Manage it in Settings.' }, { status: 409 });
    }
    try {
      const customerId =
        existing?.customerId ??
        (await recordCustomer(env.DB, session.user.id, await createCustomer(config, session.user)));
      const origin = publicOrigin(request);
      const url = await createCheckout(config, {
        customerId,
        userId: session.user.id,
        trialDays: existing?.subscriptionId ? 0 : MANAGED_SPACE_TRIAL_DAYS,
        // Stripe writes the checkout's own id over the placeholder.
        successUrl: `${origin}${BILLING_RETURN_PATH}?checkout={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/`,
      });
      return Response.json({ url }, { status: 201 });
    } catch (error) {
      if (error instanceof StripeError) {
        return paymentsUnavailable();
      }
      throw error;
    }
  });
}

/**
 * `GET /api/billing/return`: back from Stripe's checkout. Reads the subscription it started for this
 * person, gives them their space, and opens the builder in it. Anything else returns to the builder,
 * where the page says where they stand.
 */
export async function completeCheckoutAction({
  request,
  env,
  prepareWorkspace = prepareWorkspaceInBackground,
}: {
  request: Request;
  env: Env;
  prepareWorkspace?: typeof prepareWorkspaceInBackground;
}): Promise<Response> {
  const home = new Response(null, {
    status: 303,
    headers: { Location: `${publicOrigin(request)}/`, 'Cache-Control': 'no-store' },
  });
  return signedIn(request, env, async ({ session }) => {
    const config = billingConfig(env);
    const checkoutId = new URL(request.url).searchParams.get('checkout');
    if (!config || !checkoutId || checkoutId.length > 200) {
      return home;
    }
    try {
      const checkout = await checkoutSubscription(config, checkoutId);
      // Someone else's checkout id opens nothing: the subscription must be the one started for this person.
      if (checkout.userId !== session.user.id || !checkout.subscriptionId) {
        return home;
      }
      await applySubscription(env.DB, config, await readSubscription(config, checkout.subscriptionId));
      const connection = await managedConnection(env, config);
      if (connection && (await setSessionContext(env, request, connection.id))) {
        await prepareWorkspace(env, session.user.id, connection);
      }
    } catch (error) {
      if (!(error instanceof StripeError)) {
        throw error;
      }
      // The webhook still gives them their space; the builder shows it once it has.
    }
    return home;
  }).then((response) => (response.status === 401 ? home : response));
}

/** `POST /api/billing/portal`: Stripe's page for the card, invoices and cancelling. */
export function billingPortalAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const config = billingConfig(env);
    const subscription = await findManagedSubscription(env.DB, session.user.id);
    if (!config || !subscription) {
      return Response.json({ error: 'You have no subscription to manage.' }, { status: 404 });
    }
    try {
      const url = await createPortalSession(config, subscription.customerId, `${publicOrigin(request)}/settings`);
      return Response.json({ url }, { status: 201 });
    } catch (error) {
      if (error instanceof StripeError) {
        return paymentsUnavailable();
      }
      throw error;
    }
  });
}

/**
 * `POST /api/billing/webhook`: Stripe reporting a change. Only a delivery Stripe signed is read, each
 * is applied once, and what is applied is the subscription as Stripe has it now, not as the event
 * described it, so deliveries arriving out of order end in the same place. A failure answers 500 and
 * forgets the delivery, so Stripe's retry applies it.
 */
export async function stripeWebhookAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const config = billingConfig(env);
  if (!config?.webhookSecret) {
    return Response.json({ error: 'Not configured.' }, { status: 503 });
  }
  let body: string;
  try {
    // The signature is over the bytes as sent, so they are decoded and never re-serialized.
    body = new TextDecoder().decode(await readBodyBytesWithLimit(request, MAX_WEBHOOK_BYTES, 'Stripe webhook'));
  } catch {
    return Response.json({ error: 'Unreadable.' }, { status: 400 });
  }
  const event = await verifiedEvent(config.webhookSecret, body, request.headers.get('Stripe-Signature'));
  if (!event) {
    return Response.json({ error: 'Invalid signature.' }, { status: 400 });
  }
  if (!event.subscriptionId || !(await claimStripeEvent(env.DB, event))) {
    return new Response(null, { status: 204 });
  }
  try {
    await applySubscription(env.DB, config, await readSubscription(config, event.subscriptionId));
  } catch {
    await releaseStripeEvent(env.DB, event.id);
    console.error({ event: 'stripe_webhook_failed', type: event.type });
    return Response.json({ error: 'Try again.' }, { status: 500 });
  }
  return new Response(null, { status: 204 });
}

/**
 * Ends a person's subscription at Stripe before their account is erased, so nothing is charged for an
 * account that no longer exists. False when Stripe could not be told: the erasure then waits.
 */
export async function cancelSubscriptionForErasure(env: Env, userId: string): Promise<boolean> {
  const subscription = await findManagedSubscription(env.DB, userId);
  if (!subscription?.subscriptionId || subscription.status === 'canceled') {
    return true;
  }
  const config = billingConfig(env);
  if (!config) {
    return false;
  }
  try {
    await cancelSubscription(config, subscription.subscriptionId);
    return true;
  } catch {
    return false;
  }
}

function paymentsUnavailable(): Response {
  return Response.json({ error: 'Payments are unavailable right now. Try again shortly.' }, { status: 502 });
}
