import { z } from 'zod';
import { constantTimeEqual } from '~/lib/constant-time-equal';

/**
 * Stripe, for subscriptions to a space CloudChef runs: its REST API called directly, and its webhook
 * signatures checked here. CloudChef never sees a card: Checkout and the customer portal are Stripe's
 * own pages.
 *
 * The secret key and the webhook signing secret are not declared in `cloudflare.config.ts` until they
 * are set (a declared secret must exist before every deploy); without them, and without the price and
 * the managed team's id, subscriptions report themselves unavailable.
 */
const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_TIMEOUT_MS = 20_000;
/** How old a webhook's signed timestamp may be: Stripe's own recommendation. */
const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

export type BillingConfig = {
  secretKey: string;
  webhookSecret: string | null;
  priceId: string;
  /** The team, in CloudChef's own Cloudflare account, whose members are the people who subscribed. */
  managedOrgId: string;
};

type BillingEnv = Env & { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string };

/** What subscriptions need, or null when any of it is unset: they are then unavailable. */
export function billingConfig(env: Env): BillingConfig | null {
  // SAFETY: the two secrets are set on the Worker without being declared in its configuration (see above), so
  // its generated `Env` doesn't list them; each is read as possibly absent.
  const secrets = env as BillingEnv;
  const secretKey = secrets.STRIPE_SECRET_KEY?.trim();
  const priceId = env.STRIPE_PRICE_ID?.trim();
  const managedOrgId = env.MANAGED_SPACE_ORG_ID?.trim();
  if (!secretKey || !priceId || !managedOrgId) {
    return null;
  }
  return { secretKey, webhookSecret: secrets.STRIPE_WEBHOOK_SECRET?.trim() || null, priceId, managedOrgId };
}

export class StripeError extends Error {}

async function stripe<T>(
  config: BillingConfig,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  schema: z.ZodType<T>,
  form?: Record<string, string>,
): Promise<T> {
  const headers = new Headers({ Authorization: `Bearer ${config.secretKey}` });
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS) };
  if (form) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    init.body = new URLSearchParams(form);
  }
  const response = await fetch(`${STRIPE_API}${path}`, init);
  const payload: unknown = await response.json().catch(() => null);
  const parsed = response.ok ? schema.safeParse(payload) : null;
  if (!parsed?.success) {
    // Stripe's message can name the customer; only the status is logged.
    console.error({ event: 'stripe_request_failed', path: path.split('/')[1], status: response.status });
    throw new StripeError('Stripe did not accept the request.');
  }
  return parsed.data;
}

const subscriptionSchema = z.looseObject({
  id: z.string().min(1),
  customer: z.string().min(1),
  status: z.string().min(1),
  trial_end: z.number().nullable().optional(),
  cancel_at_period_end: z.boolean().optional(),
  // Newer API versions carry the period on each item, older ones on the subscription.
  current_period_end: z.number().nullable().optional(),
  items: z.looseObject({ data: z.array(z.looseObject({ current_period_end: z.number().optional() })) }).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export type StripeSubscription = {
  id: string;
  customerId: string;
  status: string;
  trialEndsAt: number | null;
  currentPeriodEndsAt: number | null;
  cancelsAtPeriodEnd: boolean;
  /** The CloudChef user the subscription was started for, as its metadata says. */
  userId: string | null;
};

function subscriptionFrom(raw: z.infer<typeof subscriptionSchema>): StripeSubscription {
  const periodEnd = raw.current_period_end ?? raw.items?.data.at(0)?.current_period_end ?? null;
  return {
    id: raw.id,
    customerId: raw.customer,
    status: raw.status,
    trialEndsAt: raw.trial_end ? raw.trial_end * 1_000 : null,
    currentPeriodEndsAt: periodEnd ? periodEnd * 1_000 : null,
    cancelsAtPeriodEnd: raw.cancel_at_period_end === true,
    userId: raw.metadata?.[USER_ID_METADATA] ?? null,
  };
}

const USER_ID_METADATA = 'cloudchef_user_id';

export async function createCustomer(config: BillingConfig, user: { id: string; email: string }): Promise<string> {
  const customer = await stripe(config, 'POST', '/customers', z.looseObject({ id: z.string().min(1) }), {
    email: user.email,
    [`metadata[${USER_ID_METADATA}]`]: user.id,
  });
  return customer.id;
}

/** Stripe's hosted page that takes the card and starts the subscription; `trialDays` 0 for none. */
export async function createCheckout(
  config: BillingConfig,
  args: { customerId: string; userId: string; trialDays: number; successUrl: string; cancelUrl: string },
): Promise<string> {
  // The free month, on a first subscription only.
  const trial = args.trialDays > 0 ? { 'subscription_data[trial_period_days]': String(args.trialDays) } : null;
  const session = await stripe(config, 'POST', '/checkout/sessions', z.looseObject({ url: z.url() }), {
    mode: 'subscription',
    customer: args.customerId,
    client_reference_id: args.userId,
    'line_items[0][price]': config.priceId,
    'line_items[0][quantity]': '1',
    // A card is asked for even when the first month is free, so the plan continues without another step.
    payment_method_collection: 'always',
    [`subscription_data[metadata][${USER_ID_METADATA}]`]: args.userId,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    ...trial,
  });
  return session.url;
}

/** The subscription a finished checkout started, for the person it was started for. */
export async function checkoutSubscription(
  config: BillingConfig,
  checkoutSessionId: string,
): Promise<{ userId: string | null; subscriptionId: string | null }> {
  const session = await stripe(
    config,
    'GET',
    `/checkout/sessions/${encodeURIComponent(checkoutSessionId)}`,
    z.looseObject({
      client_reference_id: z.string().nullable().optional(),
      subscription: z.string().nullable().optional(),
    }),
  );
  return { userId: session.client_reference_id ?? null, subscriptionId: session.subscription ?? null };
}

export async function readSubscription(config: BillingConfig, subscriptionId: string): Promise<StripeSubscription> {
  return subscriptionFrom(
    await stripe(config, 'GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`, subscriptionSchema),
  );
}

/** Ends the subscription now, with no further charge. */
export async function cancelSubscription(config: BillingConfig, subscriptionId: string): Promise<void> {
  await stripe(config, 'DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`, z.looseObject({}));
}

/** Stripe's own page for changing the card, seeing invoices and cancelling. */
export async function createPortalSession(
  config: BillingConfig,
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const session = await stripe(config, 'POST', '/billing_portal/sessions', z.looseObject({ url: z.url() }), {
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

const eventSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.looseObject({
    // An invoice's or a checkout's subscription is its id; anything else there is not one.
    object: z.looseObject({ id: z.string().optional(), subscription: z.string().nullable().catch(null).optional() }),
  }),
});

export type StripeEvent = { id: string; type: string; subscriptionId: string | null };

/**
 * The event a webhook delivery carries, or null when its signature is not Stripe's for this body, or
 * is older than the tolerance (a replay). The body must be the bytes exactly as received.
 */
export async function verifiedEvent(
  webhookSecret: string,
  body: string,
  signatureHeader: string | null,
  now = Date.now(),
): Promise<StripeEvent | null> {
  const parts = new Map<string, string[]>();
  for (const part of (signatureHeader ?? '').split(',')) {
    const [key, value] = part.split('=', 2);
    if (key && value) {
      parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()]);
    }
  }
  const timestamp = Number(parts.get('t')?.[0]);
  const signatures = parts.get('v1') ?? [];
  if (
    !Number.isFinite(timestamp) ||
    signatures.length === 0 ||
    Math.abs(now - timestamp * 1_000) > WEBHOOK_TOLERANCE_MS
  ) {
    return null;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  const expected = [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!signatures.some((signature) => constantTimeEqual(signature, expected))) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  const event = eventSchema.safeParse(payload);
  if (!event.success) {
    return null;
  }
  const object = event.data.data.object;
  const subscriptionId = event.data.type.startsWith('customer.subscription.')
    ? (object.id ?? null)
    : (object.subscription ?? null);
  return { id: event.data.id, type: event.data.type, subscriptionId };
}
