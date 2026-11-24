import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAuthSession } from '~/lib/.server/auth';
import { billingConfig } from '~/lib/.server/billing/stripe';
import { registryPhone } from '~/lib/.server/billing/registrant';
import { applySubscription, findManagedSubscription } from '~/lib/cloudflare/data/managed-subscriptions.server';
import { domainOffersSchema, spaceDomainsSchema } from '~/lib/space-domains';
import { controlPlaneDatabase, createProvenEmailUser, envWith } from '~/test/control-plane-d1';
import { completeCheckoutAction, stripeWebhookAction } from './billing';
import { buyDomainAction, listDomainsAction, removeDomainAction, searchDomainsAction } from './space-domains';

const ORIGIN = 'https://cloudchef.build';
const HOST = 'host-org';
const ACCOUNT = 'account-1';
const WEBHOOK_SECRET = 'whsec_test';

type Sent = { method: string; path: string; body: string };

/**
 * Cloudflare's registrar and Stripe, as far as buying a domain uses them. `registration` is what registering
 * answers; everything sent to either is recorded.
 */
function services(registration: 'succeeded' | 'failed') {
  const cloudflare: Sent[] = [];
  const stripe: Sent[] = [];
  const offer = (name: string, tier: string, cost: string) => ({
    name,
    registrable: true,
    tier,
    pricing: { currency: 'USD', registration_cost: cost, renewal_cost: cost },
  });
  const ok = <T>(result: T) => Response.json({ success: true, errors: [], result });
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? '');
      if (url.hostname === 'api.stripe.com') {
        const path = url.pathname.replace('/v1', '');
        stripe.push({ method, path, body });
        if (path === '/checkout/sessions') {
          return Response.json({ url: 'https://checkout.stripe.com/c/domain' });
        }
        if (path === '/checkout/sessions/cs_domain') {
          const sent = new URLSearchParams(stripe.find((call) => call.path === '/checkout/sessions')?.body);
          return Response.json({
            status: 'complete',
            subscription: 'sub_domain',
            client_reference_id: sent.get('client_reference_id'),
            metadata: { cloudchef_domain_id: sent.get('metadata[cloudchef_domain_id]') },
            customer_details: {
              name: 'Sam Baker',
              email: 'sam@example.com',
              phone: '+14155550123',
              address: {
                line1: '1 Main St',
                line2: null,
                city: 'Austin',
                state: 'TX',
                postal_code: '78701',
                country: 'US',
              },
            },
          });
        }
        if (path === '/subscriptions/sub_domain' && method === 'GET') {
          return Response.json({
            id: 'sub_domain',
            customer: 'cus_1',
            status: 'canceled',
            cancel_at_period_end: false,
            metadata: { cloudchef_domain_id: 'whichever' },
          });
        }
        return Response.json({});
      }
      const path = url.pathname.replace('/client/v4', '');
      cloudflare.push({ method, path: `${path}${url.search}`, body });
      if (path === `/accounts/${ACCOUNT}/registrar/domain-search`) {
        return ok({
          domains: [
            offer('sunrisebakery.com', 'standard', '8.57'),
            offer('sunrise.bakery', 'premium', '900.00'),
            { name: 'sunrisebakery.uk', registrable: false, reason: 'extension_not_supported_via_api' },
          ],
        });
      }
      if (path === `/accounts/${ACCOUNT}/registrar/domain-check`) {
        const { domains } = z.object({ domains: z.array(z.string()) }).parse(JSON.parse(body));
        return ok({
          domains: domains.map((name) => offer(name, name.endsWith('.bakery') ? 'premium' : 'standard', '8.57')),
        });
      }
      if (path === `/accounts/${ACCOUNT}/registrar/registrations` && method === 'POST') {
        return ok(
          registration === 'succeeded'
            ? { state: 'succeeded', context: { registration: { expires_at: '2027-11-24T00:00:00Z' } } }
            : { state: 'failed' },
        );
      }
      if (path === '/zones') {
        return ok([{ id: 'zone-bought' }]);
      }
      return ok({});
    }),
  );
  return { cloudflare, stripe };
}

/** A binding's text, as text: the declared type of each is the exact text the configuration gives it. */
const text = (value: string): string => value;

/** Sam, subscribed, with a published project in their space. */
async function setup() {
  const { database, db } = controlPlaneDatabase();
  const operator = await createProvenEmailUser(db, 'operator@cloudchef.example');
  database
    .prepare('INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)')
    .run(HOST, 'Host');
  database
    .prepare("INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', 1)")
    .run(HOST, operator.id);
  database
    .prepare(
      `INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
       VALUES ('host-connection', ?, ?, 'active', 1, 1)`,
    )
    .run(HOST, ACCOUNT);
  // SAFETY: the bindings' declared types are the empty text the configuration gives them, and the token is not
  // declared at all until it is set; the handlers read each only as text.
  const env = envWith({
    DB: db,
    STRIPE_SECRET_KEY: text('sk_test'),
    STRIPE_WEBHOOK_SECRET: text(WEBHOOK_SECRET),
    STRIPE_PRICE_ID: text('price_1'),
    STRIPE_DOMAIN_PRODUCT_ID: text('prod_domain'),
    MANAGED_SPACE_ORG_ID: text(HOST),
    MANAGED_DOMAINS_ZONE_ID: text('zone-1'),
    MANAGED_DOMAINS_CNAME_TARGET: text('domains.cloudchef.build'),
    MANAGED_DOMAINS_ACCOUNT_ID: text(ACCOUNT),
    MANAGED_DOMAINS_API_TOKEN: text('token'),
  } as Partial<Env>);
  const billing = billingConfig(env);
  if (!billing) {
    throw new Error('Billing is not configured.');
  }
  const sam = await createProvenEmailUser(db, 'sam@example.com');
  await applySubscription(db, billing, {
    id: 'sub_1',
    customerId: 'cus_1',
    status: 'active',
    trialEndsAt: null,
    currentPeriodEndsAt: 2_000,
    cancelsAtPeriodEnd: false,
    userId: sam.id,
    domainId: null,
  });
  const spaceId = (await findManagedSubscription(db, sam.id))?.spaceOrgId ?? '';
  const connection = z
    .object({ id: z.string() })
    .parse(database.prepare('SELECT id FROM cloudflare_connections WHERE org_id = ?').get(spaceId));
  const project = crypto.randomUUID();
  database
    .prepare(
      `INSERT INTO org_projects (id, connection_id, org_id, name, artifact_repo, deploys_with, deploy_worker_name, created_from, created_at)
       VALUES (?, ?, ?, 'Shop', 't-1', 'cloudchef', 'shop-worker', 'chat', 1)`,
    )
    .run(project, connection.id, spaceId);
  const cookie = (await createAuthSession(env, sam.id, new Request(ORIGIN))).cookie.split(';')[0] ?? '';
  const get = (path: string) => new Request(`${ORIGIN}${path}`, { headers: { Origin: ORIGIN, cookie } });
  const post = (path: string, body: Readonly<Record<string, string>>) =>
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { Origin: ORIGIN, cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const domains = async () => {
    const response = await listDomainsAction({ request: get(`/api/domains?projectId=${project}`), env });
    return spaceDomainsSchema.parse(await response.json());
  };
  const buy = (hostname: string) =>
    buyDomainAction({ request: post('/api/domains/buy', { projectId: project, hostname }), env });
  const back = () => completeCheckoutAction({ request: get('/api/billing/return?domain=cs_domain'), env });
  return { database, db, env, sam, project, get, post, domains, buy, back };
}

async function signed(body: string): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  const hex = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return new Request(`${ORIGIN}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${timestamp},v1=${hex}` },
    body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buying a domain for a project in a space CloudChef runs', () => {
  it('offers names anyone may register at a standard price, for what they cost plus ten dollars a year', async () => {
    const { env, project, get, domains } = await setup();
    services('succeeded');
    expect((await domains()).buying).toBe(true);
    const found = await searchDomainsAction({
      request: get(`/api/domains/search?projectId=${project}&q=sunrise%20bakery`),
      env,
    });
    expect(domainOffersSchema.parse(await found.json())).toEqual({
      offers: [{ hostname: 'sunrisebakery.com', yearlyPriceUsd: 18.57 }],
    });
  });

  it('takes the card, registers the domain in the buyer’s name, points it at the project, and only then charges', async () => {
    const { database, env, sam, project, domains, buy, back } = await setup();
    const { cloudflare, stripe } = services('succeeded');
    // A premium name is the registry's to price each year, so it is not sold.
    expect((await buy('sunrise.bakery')).status).toBe(409);

    const checkout = await buy('SunriseBakery.com');
    await expect(checkout.json()).resolves.toEqual({ url: 'https://checkout.stripe.com/c/domain' });
    const form = Object.fromEntries(new URLSearchParams(stripe.at(-1)?.body));
    expect(form).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      client_reference_id: sam.id,
      'line_items[0][price_data][product]': 'prod_domain',
      'line_items[0][price_data][unit_amount]': '1857',
      'line_items[0][price_data][recurring][interval]': 'year',
      billing_address_collection: 'required',
      'phone_number_collection[enabled]': 'true',
      'subscription_data[trial_period_days]': '1',
      success_url: `${ORIGIN}/api/billing/return?domain={CHECKOUT_SESSION_ID}`,
    });
    // The name is held while the checkout is open, with nothing registered or charged.
    expect((await domains()).domains).toMatchObject([
      { hostname: 'sunrisebakery.com', kind: 'bought', status: 'pending', yearlyPriceUsd: 18.57 },
    ]);
    expect(cloudflare.some((call) => call.path.endsWith('/registrar/registrations'))).toBe(false);

    const returned = await back();
    expect(returned.headers.get('location')).toBe(`${ORIGIN}/?domains=${project}`);
    const registration = cloudflare.find((call) => call.path.endsWith('/registrar/registrations'));
    expect(JSON.parse(registration?.body ?? '{}')).toEqual({
      domain_name: 'sunrisebakery.com',
      auto_renew: true,
      contacts: {
        registrant: {
          email: 'sam@example.com',
          phone: '+1.4155550123',
          postal_info: {
            name: 'Sam Baker',
            address: { street: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701', country_code: 'US' },
          },
        },
      },
    });
    // The domain and its www go to the project's own Worker.
    const attached = cloudflare
      .filter((call) => call.method === 'PUT' && call.path.endsWith('/workers/domains'))
      .map((call) =>
        z.object({ hostname: z.string(), service: z.string(), zone_id: z.string() }).parse(JSON.parse(call.body)),
      );
    expect(attached).toEqual([
      { hostname: 'sunrisebakery.com', service: 'shop-worker', zone_id: 'zone-bought' },
      { hostname: 'www.sunrisebakery.com', service: 'shop-worker', zone_id: 'zone-bought' },
    ]);
    // Registered and attached: now the first year is charged.
    const charged = stripe.filter((call) => call.method === 'POST' && call.path === '/subscriptions/sub_domain');
    expect(charged.map((call) => call.body)).toEqual(['trial_end=now']);
    expect((await domains()).domains).toMatchObject([{ hostname: 'sunrisebakery.com', status: 'active' }]);

    // Stripe's webhook reports the same checkout: it is registered and charged once.
    await back();
    expect(cloudflare.filter((call) => call.path.endsWith('/registrar/registrations'))).toHaveLength(1);
    expect(stripe.filter((call) => call.body === 'trial_end=now')).toHaveLength(1);

    // The domain's subscription is its own: it never stands in for the subscription to the space.
    await expect(findManagedSubscription(env.DB, sam.id)).resolves.toMatchObject({ subscriptionId: 'sub_1' });
    // Cancelled at Stripe, the registration is left to run out instead of renewing at the operator's cost.
    const cancelled = JSON.stringify({
      id: 'evt_cancel',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_domain' } },
    });
    const delivered = await stripeWebhookAction({ request: await signed(cancelled), env });
    expect(delivered.status).toBe(204);
    expect(cloudflare.at(-1)).toMatchObject({
      method: 'PATCH',
      path: `/accounts/${ACCOUNT}/registrar/registrations/sunrisebakery.com`,
      body: JSON.stringify({ auto_renew: false }),
    });
    await expect(findManagedSubscription(env.DB, sam.id)).resolves.toMatchObject({
      subscriptionId: 'sub_1',
      status: 'active',
    });
    expect(database.prepare('SELECT COUNT(*) AS spaces FROM organizations').get()).toEqual({ spaces: 2 });
  });

  it('charges nothing for a domain that could not be registered, and lets the buyer clear it away', async () => {
    const { env, post, domains, buy, back } = await setup();
    const { stripe } = services('failed');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await buy('sunrisebakery.com');
    await back();
    // The subscription is cancelled while it has charged nothing, and never asked to charge.
    expect(stripe.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([
      '/subscriptions/sub_domain',
    ]);
    expect(stripe.some((call) => call.body === 'trial_end=now')).toBe(false);
    const [failed] = (await domains()).domains;
    expect(failed).toMatchObject({ status: 'failed', waitingFor: expect.stringContaining('you were not charged') });
    const removed = await removeDomainAction({ request: post('/api/domains/remove', { id: failed?.id ?? '' }), env });
    expect(removed.status).toBe(204);
    expect((await domains()).domains).toEqual([]);
  });
});

describe('a phone number for a registry', () => {
  it.each([
    ['+14155550123', '+1.4155550123'],
    ['+44 20 7123 4567', '+44.2071234567'],
    ['+81312345678', '+81.312345678'],
    ['+8801712345678', '+880.1712345678'],
    ['+7 495 123-45-67', '+7.4951234567'],
  ])('writes %s as %s', (phone, registry) => {
    expect(registryPhone(phone)).toBe(registry);
  });

  it.each(['4155550123', '+1', 'call me', null])('has none for %s', (phone) => {
    expect(registryPhone(phone)).toBeNull();
  });
});
