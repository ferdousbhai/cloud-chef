import { afterEach, describe, expect, it, vi } from 'vitest';
import { billingConfig } from '~/lib/.server/billing/stripe';
import { applySubscription, findManagedSubscription } from '~/lib/cloudflare/data/managed-subscriptions.server';
import { controlPlaneDatabase, createProvenEmailUser, envWith } from '~/test/control-plane-d1';
import { syncSpaceSeats } from './space-seats';

const HOST = 'host-org';
/** A binding's text, as text: the declared type of each is the exact text the configuration gives it. */
const text = (value: string): string => value;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('who a space’s subscriber pays for', () => {
  it('is everyone in the space: the subscription is set to their number when it changes, and left alone when it has not', async () => {
    const { database, db } = controlPlaneDatabase();
    database
      .prepare('INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)')
      .run(HOST, 'Host');
    database
      .prepare(
        `INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
         VALUES ('host-connection', ?, 'account-1', 'active', 1, 1)`,
      )
      .run(HOST);
    // SAFETY: the billing bindings' declared types are the exact text the configuration gives them; they are read
    // only as text.
    const env = envWith({
      DB: db,
      STRIPE_SECRET_KEY: text('sk_test'),
      STRIPE_PRICE_ID: text('price_1'),
      MANAGED_SPACE_ORG_ID: text(HOST),
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
    // Stripe, holding the subscription's one item and how many it is for.
    let quantity = 1;
    const updates: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) => {
        if (init?.method === 'POST') {
          const form = new URLSearchParams(init.body instanceof URLSearchParams ? init.body : '');
          updates.push(form.toString());
          quantity = Number(form.get('items[0][quantity]'));
        }
        return Response.json({ items: { data: [{ id: 'si_1', quantity }] } });
      }),
    );

    await expect(syncSpaceSeats(env, spaceId)).resolves.toBe(1);
    expect(updates).toEqual([]);

    const gia = await createProvenEmailUser(db, 'gia@example.com');
    database
      .prepare("INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'member', 2)")
      .run(spaceId, gia.id);
    await expect(syncSpaceSeats(env, spaceId)).resolves.toBe(2);
    // Charged for the part of the period that is left, as Stripe prorates it.
    expect(Object.fromEntries(new URLSearchParams(updates[0]))).toEqual({
      'items[0][id]': 'si_1',
      'items[0][quantity]': '2',
      proration_behavior: 'create_prorations',
    });
    await syncSpaceSeats(env, spaceId);
    expect(updates).toHaveLength(1);

    database.prepare('DELETE FROM organization_members WHERE org_id = ? AND user_id = ?').run(spaceId, gia.id);
    await expect(syncSpaceSeats(env, spaceId)).resolves.toBe(1);
    expect(quantity).toBe(1);
    // A team that pays Cloudflare itself has no subscription here to change.
    await expect(syncSpaceSeats(env, HOST)).resolves.toBeNull();
  });
});
