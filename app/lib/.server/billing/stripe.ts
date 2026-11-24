import { z } from 'zod';
import { constantTimeEqual } from '~/lib/constant-time-equal';

/**
 * Stripe, for subscriptions to a space CloudChef runs and the building credit bought for one: its REST API
 * called directly, and its webhook signatures checked here. CloudChef never sees a card: Checkout and the customer portal are Stripe's
 * own pages.
 *
 * Without the secret key, the price or the managed team's id, subscriptions report themselves unavailable.
 */
const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_TIMEOUT_MS = 20_000;
/** How old a webhook's signed timestamp may be: Stripe's own recommendation. */
const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

export type BillingConfig = {
  secretKey: string;
  webhookSecret: string | null;
  priceId: string;
  /** CloudChef's own customer-portal configuration; null opens the Stripe account's default one. */
  portalConfigurationId: string | null;
  /** The host team, connected to CloudChef's own Cloudflare account, where every space is made. */
  managedOrgId: string;
  /** The one-time Stripe price of each amount of building credit, by its dollars. */
  creditPriceIds: Readonly<Record<string, string>>;
  /** The Stripe product a bought domain's yearly subscription is a price of; null where buying is not set up. */
  domainProductId: string | null;
};

const creditPriceIdsSchema = z.record(z.string(), z.string().min(1));

/** The configured credit prices; none when the text is empty or unreadable, and credit then can't be bought. */
function creditPriceIds(stored: string | undefined): Record<string, string> {
  try {
    return creditPriceIdsSchema.safeParse(JSON.parse(stored?.trim() || '{}')).data ?? {};
  } catch {
    return {};
  }
}

/** What subscriptions need, or null when any of it is unset: they are then unavailable. */
export function billingConfig(env: Env): BillingConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const priceId = env.STRIPE_PRICE_ID?.trim();
  const managedOrgId = env.MANAGED_SPACE_ORG_ID?.trim();
  if (!secretKey || !priceId || !managedOrgId) {
    return null;
  }
  return {
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || null,
    priceId,
    portalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID?.trim() || null,
    managedOrgId,
    creditPriceIds: creditPriceIds(env.STRIPE_CREDIT_PRICE_IDS),
    domainProductId: env.STRIPE_DOMAIN_PRODUCT_ID?.trim() || null,
  };
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
  /**
   * The bought domain (`space_domains.id`) this subscription pays for each year, as its metadata says; null for a
   * subscription to a space. The two are never mistaken for each other.
   */
  domainId: string | null;
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
    domainId: raw.metadata?.[DOMAIN_ID_METADATA] ?? null,
  };
}

const USER_ID_METADATA = 'cloudchef_user_id';
const DOMAIN_ID_METADATA = 'cloudchef_domain_id';

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
  // Free days, on a first subscription only and when the plan has any.
  const trial = args.trialDays > 0 ? { 'subscription_data[trial_period_days]': String(args.trialDays) } : null;
  const session = await stripe(config, 'POST', '/checkout/sessions', z.looseObject({ url: z.url() }), {
    mode: 'subscription',
    customer: args.customerId,
    client_reference_id: args.userId,
    'line_items[0][price]': config.priceId,
    'line_items[0][quantity]': '1',
    // A card is asked for even when the first days are free, so the plan continues without another step.
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

const CREDIT_ORG_METADATA = 'cloudchef_credit_org_id';

/** Stripe's hosted page that takes one payment for building credit in the space `orgId`. */
export async function createCreditCheckout(
  config: BillingConfig,
  args: { customerId: string; userId: string; orgId: string; priceId: string; successUrl: string; cancelUrl: string },
): Promise<string> {
  const session = await stripe(config, 'POST', '/checkout/sessions', z.looseObject({ url: z.url() }), {
    mode: 'payment',
    customer: args.customerId,
    client_reference_id: args.userId,
    'line_items[0][price]': args.priceId,
    'line_items[0][quantity]': '1',
    [`metadata[${CREDIT_ORG_METADATA}]`]: args.orgId,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  });
  return session.url;
}

export type CreditCheckout = { id: string; userId: string | null; orgId: string; amountUsd: number };

/**
 * A finished checkout as a purchase of building credit: who bought it, for which space, and the whole dollars
 * Stripe says were paid before tax. Null unless it is a paid one-time payment made for a space.
 */
export async function readCreditCheckout(
  config: BillingConfig,
  checkoutSessionId: string,
): Promise<CreditCheckout | null> {
  const session = await stripe(
    config,
    'GET',
    `/checkout/sessions/${encodeURIComponent(checkoutSessionId)}`,
    z.looseObject({
      id: z.string().min(1),
      mode: z.string().optional(),
      payment_status: z.string().optional(),
      amount_subtotal: z.number().nullable().optional(),
      client_reference_id: z.string().nullable().optional(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
    }),
  );
  const orgId = session.metadata?.[CREDIT_ORG_METADATA];
  const amountUsd = Math.floor((session.amount_subtotal ?? 0) / 100);
  if (session.mode !== 'payment' || session.payment_status !== 'paid' || !orgId || amountUsd <= 0) {
    return null;
  }
  return { id: session.id, userId: session.client_reference_id ?? null, orgId, amountUsd };
}

/**
 * Stripe's hosted page that takes the card for a bought domain's yearly subscription, with the buyer's name,
 * address and phone, which the registration is made in. It starts with a day before the first charge: the
 * domain is registered in that day and the charge then made at once (`chargeSubscriptionNow`), or, if it can't
 * be registered, the subscription is cancelled with nothing charged.
 */
export async function createDomainCheckout(
  config: BillingConfig,
  args: {
    customerId: string;
    userId: string;
    domainId: string;
    hostname: string;
    yearlyPriceCents: number;
    productId: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<string> {
  const session = await stripe(config, 'POST', '/checkout/sessions', z.looseObject({ url: z.url() }), {
    mode: 'subscription',
    customer: args.customerId,
    client_reference_id: args.userId,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product]': args.productId,
    'line_items[0][price_data][unit_amount]': String(args.yearlyPriceCents),
    'line_items[0][price_data][recurring][interval]': 'year',
    'line_items[0][quantity]': '1',
    payment_method_collection: 'always',
    billing_address_collection: 'required',
    'phone_number_collection[enabled]': 'true',
    // An existing customer's details are kept as they give them here.
    'customer_update[address]': 'auto',
    'customer_update[name]': 'auto',
    'subscription_data[trial_period_days]': '1',
    'subscription_data[description]': args.hostname,
    [`subscription_data[metadata][${DOMAIN_ID_METADATA}]`]: args.domainId,
    [`metadata[${DOMAIN_ID_METADATA}]`]: args.domainId,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  });
  return session.url;
}

/** Who paid, as they told Stripe's page: the details a bought domain is registered in. */
export type CheckoutContact = {
  name: string | null;
  email: string | null;
  phone: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
};

export type DomainCheckout = {
  userId: string | null;
  domainId: string;
  subscriptionId: string;
  contact: CheckoutContact;
};

const optionalText = z.string().nullable().optional();

/** A finished checkout as the purchase of a domain; null unless it completed and started that subscription. */
export async function readDomainCheckout(
  config: BillingConfig,
  checkoutSessionId: string,
): Promise<DomainCheckout | null> {
  const session = await stripe(
    config,
    'GET',
    `/checkout/sessions/${encodeURIComponent(checkoutSessionId)}`,
    z.looseObject({
      status: optionalText,
      subscription: optionalText,
      client_reference_id: optionalText,
      metadata: z.record(z.string(), z.string()).nullable().optional(),
      customer_details: z
        .looseObject({
          name: optionalText,
          email: optionalText,
          phone: optionalText,
          address: z
            .looseObject({
              line1: optionalText,
              line2: optionalText,
              city: optionalText,
              state: optionalText,
              postal_code: optionalText,
              country: optionalText,
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    }),
  );
  const domainId = session.metadata?.[DOMAIN_ID_METADATA];
  if (session.status !== 'complete' || !session.subscription || !domainId) {
    return null;
  }
  const details = session.customer_details;
  const address = details?.address;
  return {
    userId: session.client_reference_id ?? null,
    domainId,
    subscriptionId: session.subscription,
    contact: {
      name: details?.name ?? null,
      email: details?.email ?? null,
      phone: details?.phone ?? null,
      address: address
        ? {
            line1: address.line1 ?? null,
            line2: address.line2 ?? null,
            city: address.city ?? null,
            state: address.state ?? null,
            postalCode: address.postal_code ?? null,
            country: address.country ?? null,
          }
        : null,
    },
  };
}

/** Ends a subscription's days before its first charge, so the charge is made now. */
export async function chargeSubscriptionNow(config: BillingConfig, subscriptionId: string): Promise<void> {
  await stripe(config, 'POST', `/subscriptions/${encodeURIComponent(subscriptionId)}`, z.looseObject({}), {
    trial_end: 'now',
  });
}

export async function readSubscription(config: BillingConfig, subscriptionId: string): Promise<StripeSubscription> {
  return subscriptionFrom(
    await stripe(config, 'GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`, subscriptionSchema),
  );
}

/**
 * Makes the subscription pay for `seats` people, charging or crediting the subscriber for the part of the
 * period that is left, as Stripe prorates it. Does nothing when it already pays for that many.
 */
export async function setSubscriptionSeats(
  config: BillingConfig,
  subscriptionId: string,
  seats: number,
): Promise<void> {
  const subscription = await stripe(
    config,
    'GET',
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    z.looseObject({
      items: z.looseObject({
        data: z.array(z.looseObject({ id: z.string().min(1), quantity: z.number().optional() })),
      }),
    }),
  );
  const item = subscription.items.data.at(0);
  if (!item || item.quantity === seats) {
    return;
  }
  await stripe(config, 'POST', `/subscriptions/${encodeURIComponent(subscriptionId)}`, z.looseObject({}), {
    'items[0][id]': item.id,
    'items[0][quantity]': String(seats),
    proration_behavior: 'create_prorations',
  });
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
  // CloudChef's own portal, where the Stripe account's default one is another product's.
  const configuration = config.portalConfigurationId ? { configuration: config.portalConfigurationId } : null;
  const session = await stripe(config, 'POST', '/billing_portal/sessions', z.looseObject({ url: z.url() }), {
    customer: customerId,
    return_url: returnUrl,
    ...configuration,
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

export type StripeEvent = {
  id: string;
  type: string;
  subscriptionId: string | null;
  /** The checkout a `checkout.session.*` event is about. */
  checkoutSessionId: string | null;
};

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
  const checkoutSessionId = event.data.type.startsWith('checkout.session.') ? (object.id ?? null) : null;
  return { id: event.data.id, type: event.data.type, subscriptionId, checkoutSessionId };
}
