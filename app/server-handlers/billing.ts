import { setSessionContext } from '~/lib/.server/auth';
import {
  billingConfig,
  cancelSubscription,
  checkoutSubscription,
  createCheckout,
  createCreditCheckout,
  createCustomer,
  createPortalSession,
  readCreditCheckout,
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
  recordCreditPurchase,
  recordCustomer,
  releaseStripeEvent,
  spaceUsage,
} from '~/lib/cloudflare/data/managed-subscriptions.server';
import { z } from 'zod';
import { readJsonRequest } from '~/lib/.server/request-guards';
import {
  MANAGED_SPACE_CREDIT_AMOUNTS_USD,
  MANAGED_SPACE_MONTHLY_PRICE_USD,
  MANAGED_SPACE_TRIAL_DAYS,
} from '~/lib/managed-space';
import { prepareWorkspaceInBackground } from './cloudflare-integration';
import { signedIn } from './signed-in';
import { applyDomainSubscription, completeDomainPurchase } from './space-domains';

/**
 * Subscribing to a space CloudChef runs (`app/lib/cloudflare/data/managed-subscriptions.server.ts`):
 * what the plan is and where this person stands, Stripe's checkout and its portal, and the webhook
 * Stripe reports every change of a subscription to. The webhook is the record; the return from checkout
 * reads the same subscription itself so the person isn't kept waiting for it.
 */
export const BILLING_RETURN_PATH = '/api/billing/return';
const MAX_WEBHOOK_BYTES = 256 * 1024;
const UNAVAILABLE = 'A space CloudChef runs is not open yet.';

/** The host team's connection while it is active: without it a subscription would buy nowhere to build. */
async function hostConnection(env: Env, config: BillingConfig) {
  const connection = await findCloudflareConnectionForOrganization(env.DB, config.managedOrgId);
  return connection?.status === 'active' ? connection : null;
}

/** The connection of the space a subscription gave its person, while it is active. */
async function spaceConnection(env: Env, subscription: { spaceOrgId: string | null } | null) {
  const connection = subscription?.spaceOrgId
    ? await findCloudflareConnectionForOrganization(env.DB, subscription.spaceOrgId)
    : null;
  return connection?.status === 'active' ? connection : null;
}

/** `GET /api/billing`: the plan, whether it can be bought here, and this person's subscription and use. */
export function billingStatusAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const config = billingConfig(env);
    const host = config ? await hostConnection(env, config) : null;
    const subscription = await findManagedSubscription(env.DB, session.user.id);
    const hasSpace = subscription !== null && givesSpace(subscription.status);
    const space = hasSpace ? await spaceConnection(env, subscription) : null;
    return Response.json(
      {
        available: host !== null,
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
        // Everyone's building in their space, against its one allowance.
        usage: space?.orgId ? await spaceUsage(env.DB, space.id, space.orgId, null) : null,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  });
}

/** `POST /api/billing/checkout`: Stripe's page for the card, which returns to `BILLING_RETURN_PATH`. */
export function startCheckoutAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const config = billingConfig(env);
    if (!config || !(await hostConnection(env, config))) {
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

const creditSchema = z.strictObject({ amountUsd: z.literal(MANAGED_SPACE_CREDIT_AMOUNTS_USD) });

/**
 * `POST /api/billing/credit`: Stripe's page for one payment of building credit, for the space this person
 * subscribes to. It returns to `BILLING_RETURN_PATH`, which records the credit.
 */
export function buyCreditAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, creditSchema, 'Choose an amount of credit.');
    if ('response' in body) {
      return body.response;
    }
    const config = billingConfig(env);
    const subscription = await findManagedSubscription(env.DB, session.user.id);
    const space = subscription && givesSpace(subscription.status) ? await spaceConnection(env, subscription) : null;
    if (!config || !subscription || !space?.orgId) {
      return Response.json({ error: 'Credit is for a space you subscribe to.' }, { status: 409 });
    }
    const priceId = config.creditPriceIds[String(body.data.amountUsd)];
    if (!priceId) {
      return Response.json({ error: 'That amount of credit is not on sale right now.' }, { status: 503 });
    }
    try {
      const origin = publicOrigin(request);
      const url = await createCreditCheckout(config, {
        customerId: subscription.customerId,
        userId: session.user.id,
        orgId: space.orgId,
        priceId,
        // Stripe writes the checkout's own id over the placeholder.
        successUrl: `${origin}${BILLING_RETURN_PATH}?credit={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/settings#subscription`,
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
 * person, gives them their space, and opens the builder in it; or, back from buying credit, records the
 * credit and returns to Settings, which shows it. Anything else returns to the builder, where the page says
 * where they stand.
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
    const query = new URL(request.url).searchParams;
    const creditId = query.get('credit');
    if (config && creditId && creditId.length <= 200) {
      try {
        const credit = await readCreditCheckout(config, creditId);
        // Only the purchase Stripe says this person paid for is recorded; the webhook records it too, once.
        if (credit && credit.userId === session.user.id) {
          await recordCreditPurchase(env.DB, credit);
        }
      } catch (error) {
        if (!(error instanceof StripeError)) {
          throw error;
        }
      }
      return new Response(null, {
        status: 303,
        headers: { Location: `${publicOrigin(request)}/settings#subscription`, 'Cache-Control': 'no-store' },
      });
    }
    const domainCheckoutId = query.get('domain');
    if (config && domainCheckoutId && domainCheckoutId.length <= 200) {
      let projectId: string | null = null;
      try {
        projectId = (await completeDomainPurchase(env, domainCheckoutId, session.user.id))?.projectId ?? null;
      } catch (error) {
        if (!(error instanceof StripeError)) {
          throw error;
        }
        // The webhook still registers it; the project's Domains dialog shows where it stands.
      }
      // Back to the builder with the project's domains open, where the purchase shows.
      const back = new URL('/', publicOrigin(request));
      if (projectId) {
        back.searchParams.set('domains', projectId);
      }
      return new Response(null, { status: 303, headers: { Location: back.toString(), 'Cache-Control': 'no-store' } });
    }
    const checkoutId = query.get('checkout');
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
      const connection = await spaceConnection(env, await findManagedSubscription(env.DB, session.user.id));
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
 * is applied once, and what is applied is the subscription, or the paid checkout of credit, as Stripe has it
 * now, not as the event described it, so deliveries arriving out of order end in the same place. A failure answers 500 and
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
  // A finished checkout with no subscription may be a purchase of credit; anything else is not CloudChef's.
  const creditCheckoutId =
    event.type === 'checkout.session.completed' && !event.subscriptionId ? event.checkoutSessionId : null;
  if ((!event.subscriptionId && !creditCheckoutId) || !(await claimStripeEvent(env.DB, event))) {
    return new Response(null, { status: 204 });
  }
  try {
    if (event.subscriptionId) {
      const subscription = await readSubscription(config, event.subscriptionId);
      if (subscription.domainId === null) {
        await applySubscription(env.DB, config, subscription);
      } else {
        // A bought domain's own yearly subscription: never a subscription to a space.
        if (event.type === 'checkout.session.completed' && event.checkoutSessionId) {
          await completeDomainPurchase(env, event.checkoutSessionId, null);
        }
        await applyDomainSubscription(env, subscription);
      }
    } else if (creditCheckoutId) {
      const credit = await readCreditCheckout(config, creditCheckoutId);
      if (credit) {
        await recordCreditPurchase(env.DB, credit);
      }
    }
  } catch {
    await releaseStripeEvent(env.DB, event.id);
    console.error({ event: 'stripe_webhook_failed', type: event.type });
    return Response.json({ error: 'Try again.' }, { status: 500 });
  }
  return new Response(null, { status: 204 });
}

/**
 * Ends a person's subscription at Stripe, and those of the domains bought for their space, before their account
 * is erased, so nothing is charged for an account that no longer exists. False when Stripe could not be told: the erasure then waits.
 */
export async function cancelSubscriptionForErasure(env: Env, userId: string): Promise<boolean> {
  const subscription = await findManagedSubscription(env.DB, userId);
  // The yearly subscriptions of the domains bought for their space end with it: they are charged to the same person.
  const domains = subscription?.spaceOrgId
    ? await env.DB.prepare(
        'SELECT stripe_subscription_id AS id FROM space_domains WHERE org_id = ? AND stripe_subscription_id IS NOT NULL',
      )
        .bind(subscription.spaceOrgId)
        .all<{ id: string }>()
    : { results: [] };
  const space = subscription?.subscriptionId && subscription.status !== 'canceled' ? [subscription.subscriptionId] : [];
  const ending = [...space, ...domains.results.map((domain) => domain.id)];
  if (ending.length === 0) {
    return true;
  }
  const config = billingConfig(env);
  if (!config) {
    return false;
  }
  try {
    for (const subscriptionId of ending) {
      await cancelSubscription(config, subscriptionId);
    }
    return true;
  } catch {
    return false;
  }
}

function paymentsUnavailable(): Response {
  return Response.json({ error: 'Payments are unavailable right now. Try again shortly.' }, { status: 502 });
}
