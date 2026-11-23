import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthSession } from '~/lib/.server/auth';
import { findManagedSubscription } from '~/lib/cloudflare/data/managed-subscriptions.server';
import { billingStatusSchema } from '~/lib/managed-space';
import { controlPlaneDatabase, createProvenEmailUser, envWith } from '~/test/control-plane-d1';
import {
  billingPortalAction,
  billingStatusAction,
  cancelSubscriptionForErasure,
  completeCheckoutAction,
  startCheckoutAction,
  stripeWebhookAction,
} from './billing';

const ORIGIN = 'https://cloudchef.build';
const ORG = 'managed-org';
const WEBHOOK_SECRET = 'whsec_test';

async function setup(configured = true) {
  const { database, db } = controlPlaneDatabase();
  const operator = await createProvenEmailUser(db, 'operator@cloudchef.example');
  database
    .prepare('INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)')
    .run(ORG, 'Spaces');
  database
    .prepare("INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', 1)")
    .run(ORG, operator.id);
  database
    .prepare(
      `INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
       VALUES ('managed-connection', ?, 'account-1', 'active', 1, 1)`,
    )
    .run(ORG);
  const billing = configured
    ? {
        STRIPE_SECRET_KEY: 'sk_test',
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        STRIPE_PRICE_ID: 'price_1',
        STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_1',
        MANAGED_SPACE_ORG_ID: ORG,
      }
    : { STRIPE_PRICE_ID: '', MANAGED_SPACE_ORG_ID: '' };
  // SAFETY: the billing bindings' declared types are the exact text the configuration gives them; the handlers
  // read each only as text.
  const env = envWith({ DB: db, ...billing } as Partial<Env>);
  const sam = await createProvenEmailUser(db, 'sam@example.com');
  const { cookie } = await createAuthSession(env, sam.id, new Request(ORIGIN));
  const member = () =>
    database
      .prepare('SELECT role, paused_at FROM organization_members WHERE org_id = ? AND user_id = ?')
      .get(ORG, sam.id);
  return { database, db, env, sam, cookie: cookie.split(';')[0], member };
}

function request(path: string, cookie: string, method: 'GET' | 'POST' = 'POST'): Request {
  return method === 'GET'
    ? new Request(`${ORIGIN}${path}`, { headers: { Origin: ORIGIN, cookie } })
    : new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { Origin: ORIGIN, cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
}

/** Stripe's API, answering each path's start with a body, and recording what it was sent. */
/** A Stripe object as these tests answer with it: flat, but for a subscription's metadata. */
type StripeAnswer = Readonly<Record<string, string | number | boolean | null | Readonly<Record<string, string>>>>;

function stripe(answers: Readonly<Record<string, StripeAnswer>>) {
  const calls: { method: string; path: string; form: Record<string, string> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname.replace('/v1', '');
      calls.push({
        method: init?.method ?? 'GET',
        path,
        form: Object.fromEntries(new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : '')),
      });
      const match = Object.keys(answers).find((prefix) => path.startsWith(prefix));
      return match ? Response.json(answers[match]) : Response.json({ error: {} }, { status: 404 });
    }),
  );
  return calls;
}

const trialing = {
  id: 'sub_1',
  customer: 'cus_1',
  status: 'trialing',
  trial_end: 1_900_000_000,
  cancel_at_period_end: false,
};

async function signature(body: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `t=${timestamp},v1=${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function webhook(body: string, stripeSignature: string): Request {
  return new Request(`${ORIGIN}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Stripe-Signature': stripeSignature },
    body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribing to a space CloudChef runs', () => {
  it('says the plan is not open while Stripe or the managed team is not set up', async () => {
    const { env, cookie } = await setup(false);
    const status = await billingStatusAction({ request: request('/api/billing', cookie, 'GET'), env });
    expect(billingStatusSchema.parse(await status.json())).toMatchObject({ available: false, subscription: null });
    const checkout = await startCheckoutAction({ request: request('/api/billing/checkout', cookie), env });
    expect(checkout.status).toBe(503);
  });

  it("sends a first-time subscriber to Stripe's checkout with a card required and no free days", async () => {
    const { db, env, sam, cookie } = await setup();
    const calls = stripe({
      '/customers': { id: 'cus_1' },
      '/checkout/sessions': { url: 'https://checkout.stripe.com/c/1' },
    });
    const status = await billingStatusAction({ request: request('/api/billing', cookie, 'GET'), env });
    expect(billingStatusSchema.parse(await status.json())).toMatchObject({
      available: true,
      monthlyPriceUsd: 20,
      trialDays: 0,
    });

    const checkout = await startCheckoutAction({ request: request('/api/billing/checkout', cookie), env });
    expect(checkout.status).toBe(201);
    await expect(checkout.json()).resolves.toEqual({ url: 'https://checkout.stripe.com/c/1' });
    expect(calls[0]).toMatchObject({ path: '/customers', form: { email: 'sam@example.com' } });
    expect(calls[1].form).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      client_reference_id: sam.id,
      'line_items[0][price]': 'price_1',
      payment_method_collection: 'always',
      success_url: `${ORIGIN}/api/billing/return?checkout={CHECKOUT_SESSION_ID}`,
    });
    expect(calls[1].form).not.toHaveProperty('subscription_data[trial_period_days]');
    // The customer is kept, so a second try doesn't make another.
    await expect(findManagedSubscription(db, sam.id)).resolves.toMatchObject({ customerId: 'cus_1', status: 'none' });
    await startCheckoutAction({ request: request('/api/billing/checkout', cookie), env });
    expect(calls.filter(({ path }) => path === '/customers')).toHaveLength(1);
  });

  it('gives the space on the return from checkout, only for the person the checkout was started for', async () => {
    const { env, sam, cookie, member } = await setup();
    const prepareWorkspace = vi.fn(async () => undefined);
    stripe({
      '/checkout/sessions/cs_other': { client_reference_id: 'someone-else', subscription: 'sub_1' },
      '/checkout/sessions/cs_1': { client_reference_id: sam.id, subscription: 'sub_1' },
      '/subscriptions/sub_1': { ...trialing, metadata: { cloudchef_user_id: sam.id } },
    });
    const stolen = await completeCheckoutAction({
      request: request('/api/billing/return?checkout=cs_other', cookie, 'GET'),
      env,
      prepareWorkspace,
    });
    expect(stolen.status).toBe(303);
    expect(member()).toBeUndefined();

    const done = await completeCheckoutAction({
      request: request('/api/billing/return?checkout=cs_1', cookie, 'GET'),
      env,
      prepareWorkspace,
    });
    expect(done.headers.get('location')).toBe(`${ORIGIN}/`);
    expect(member()).toEqual({ role: 'member', paused_at: null });
    expect(prepareWorkspace).toHaveBeenCalledOnce();

    // Subscribed: checkout is refused, and a later subscription has no second free month.
    const again = await startCheckoutAction({ request: request('/api/billing/checkout', cookie), env });
    expect(again.status).toBe(409);
    const status = await billingStatusAction({ request: request('/api/billing', cookie, 'GET'), env });
    expect(billingStatusSchema.parse(await status.json())).toMatchObject({
      trialDays: 0,
      subscription: { status: 'trialing', hasSpace: true },
      usage: { usedUsd: 0, allowanceUsd: 20 },
    });
  });

  it("opens Stripe's portal for a subscriber, and has none to open for anyone else", async () => {
    const { db, env, sam, cookie } = await setup();
    const none = await billingPortalAction({ request: request('/api/billing/portal', cookie), env });
    expect(none.status).toBe(404);
    await db
      .prepare(
        `INSERT INTO managed_subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, created_at, updated_at)
         VALUES (?, 'cus_1', 'sub_1', 'active', 1, 1)`,
      )
      .bind(sam.id)
      .run();
    const calls = stripe({ '/billing_portal/sessions': { url: 'https://billing.stripe.com/p/1' } });
    const portal = await billingPortalAction({ request: request('/api/billing/portal', cookie), env });
    await expect(portal.json()).resolves.toEqual({ url: 'https://billing.stripe.com/p/1' });
    expect(calls[0].form).toEqual({
      customer: 'cus_1',
      return_url: `${ORIGIN}/settings`,
      configuration: 'bpc_1',
    });
  });
});

describe("Stripe's webhook", () => {
  it('applies a signed delivery once, as the subscription stands at Stripe now', async () => {
    const { env, sam, member } = await setup();
    const calls = stripe({
      '/subscriptions/sub_1': { ...trialing, status: 'past_due', metadata: { cloudchef_user_id: sam.id } },
    });
    // The event says "active"; Stripe, asked, says the payment has since failed.
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'active' } },
    });
    const first = await stripeWebhookAction({ request: webhook(body, await signature(body)), env });
    expect(first.status).toBe(204);
    expect(member()).toBeUndefined();
    await expect(findManagedSubscription(env.DB, sam.id)).resolves.toMatchObject({ status: 'past_due' });

    const again = await stripeWebhookAction({ request: webhook(body, await signature(body)), env });
    expect(again.status).toBe(204);
    expect(calls).toHaveLength(1);
  });

  it('refuses an unsigned delivery, and lets Stripe retry one it could not apply', async () => {
    const { env } = await setup();
    const body = JSON.stringify({
      id: 'evt_2',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1' } },
    });
    const unsigned = await stripeWebhookAction({ request: webhook(body, 't=1,v1=00'), env });
    expect(unsigned.status).toBe(400);

    const calls = stripe({});
    const failed = await stripeWebhookAction({ request: webhook(body, await signature(body)), env });
    expect(failed.status).toBe(500);
    stripe({ '/subscriptions/sub_1': { ...trialing, status: 'canceled' } });
    const retried = await stripeWebhookAction({ request: webhook(body, await signature(body)), env });
    expect(retried.status).toBe(204);
    expect(calls).toHaveLength(1);
  });
});

describe('erasing an account with a subscription', () => {
  it('cancels the subscription at Stripe first, and waits when Stripe cannot be told', async () => {
    const { db, env, sam } = await setup();
    await expect(cancelSubscriptionForErasure(env, sam.id)).resolves.toBe(true);
    await db
      .prepare(
        `INSERT INTO managed_subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, created_at, updated_at)
         VALUES (?, 'cus_1', 'sub_1', 'active', 1, 1)`,
      )
      .bind(sam.id)
      .run();
    stripe({});
    await expect(cancelSubscriptionForErasure(env, sam.id)).resolves.toBe(false);
    const calls = stripe({ '/subscriptions/sub_1': { id: 'sub_1', status: 'canceled' } });
    await expect(cancelSubscriptionForErasure(env, sam.id)).resolves.toBe(true);
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/subscriptions/sub_1' });
  });
});
