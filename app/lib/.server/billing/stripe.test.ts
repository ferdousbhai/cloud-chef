import { describe, expect, it } from 'vitest';
import { envWith } from '~/test/control-plane-d1';
import { billingConfig, verifiedEvent } from './stripe';

const SECRET = 'whsec_test';

async function signed(body: string, timestamp: number, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  const hex = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${hex}`;
}

const NOW = 1_800_000_000_000;
const body = JSON.stringify({
  id: 'evt_1',
  type: 'customer.subscription.updated',
  data: { object: { id: 'sub_1', status: 'active' } },
});

describe("Stripe's webhook deliveries", () => {
  it('reads an event Stripe signed for these exact bytes', async () => {
    await expect(verifiedEvent(SECRET, body, await signed(body, NOW / 1_000), NOW)).resolves.toEqual({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      subscriptionId: 'sub_1',
      checkoutSessionId: null,
    });
  });

  it('names the subscription of an event about something else, such as a finished checkout or an invoice', async () => {
    const checkout = JSON.stringify({
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', subscription: 'sub_9' } },
    });
    await expect(verifiedEvent(SECRET, checkout, await signed(checkout, NOW / 1_000), NOW)).resolves.toMatchObject({
      subscriptionId: 'sub_9',
      checkoutSessionId: 'cs_1',
    });
  });

  it('refuses a body that was changed, another secret, a missing signature, and a replay', async () => {
    const signature = await signed(body, NOW / 1_000);
    await expect(verifiedEvent(SECRET, body.replace('active', 'trialing'), signature, NOW)).resolves.toBeNull();
    await expect(verifiedEvent(SECRET, body, await signed(body, NOW / 1_000, 'whsec_other'), NOW)).resolves.toBeNull();
    await expect(verifiedEvent(SECRET, body, null, NOW)).resolves.toBeNull();
    await expect(verifiedEvent(SECRET, body, signature, NOW + 6 * 60_000)).resolves.toBeNull();
  });
});

describe('whether subscriptions are available', () => {
  it('needs the secret key, the price and the managed team, and reads the webhook secret when it is set', () => {
    const all = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_PRICE_ID: 'price_1', MANAGED_SPACE_ORG_ID: 'org-1' };
    // SAFETY: the bindings' declared types are the exact text the configuration gives them; `billingConfig` reads
    // each only as text.
    const env = (bindings: Record<string, string>) => envWith(bindings as Partial<Env>);
    expect(billingConfig(env(all))).toEqual({
      secretKey: 'sk_test',
      webhookSecret: null,
      priceId: 'price_1',
      portalConfigurationId: null,
      managedOrgId: 'org-1',
      creditPriceIds: {},
      domainProductId: null,
    });
    // The credit prices are read from their text; text that can't be read sells none.
    expect(billingConfig(env({ ...all, STRIPE_CREDIT_PRICE_IDS: '{"20":"price_c20"}' }))?.creditPriceIds).toEqual({
      '20': 'price_c20',
    });
    expect(billingConfig(env({ ...all, STRIPE_CREDIT_PRICE_IDS: 'not json' }))?.creditPriceIds).toEqual({});
    expect(billingConfig(env({ ...all, STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_1' }))?.portalConfigurationId).toBe(
      'bpc_1',
    );
    for (const missing of Object.keys(all)) {
      expect(billingConfig(env({ ...all, [missing]: '' }))).toBeNull();
    }
  });
});
