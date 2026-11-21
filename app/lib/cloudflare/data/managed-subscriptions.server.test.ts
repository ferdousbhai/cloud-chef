import { describe, expect, it } from 'vitest';
import type { BillingConfig, StripeSubscription } from '~/lib/.server/billing/stripe';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { piWorkersAiModel } from '~/lib/.server/llm/pi-model-catalog';
import { controlPlaneDatabase, createProvenEmailUser } from '~/test/control-plane-d1';
import {
  applySubscription,
  claimStripeEvent,
  findManagedSubscription,
  MONTHLY_USAGE_ALLOWANCE_USD,
  recordCustomer,
  spaceUsage,
} from './managed-subscriptions.server';

const ORG = 'managed-org';
const CONNECTION = 'managed-connection';
const config: BillingConfig = { secretKey: 'sk_test', webhookSecret: 'whsec', priceId: 'price_1', managedOrgId: ORG };

async function setup() {
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
       VALUES (?, ?, 'account-1', 'active', 1, 1)`,
    )
    .run(CONNECTION, ORG);
  const sam = await createProvenEmailUser(db, 'sam@example.com');
  const member = () =>
    database
      .prepare('SELECT role, paused_at FROM organization_members WHERE org_id = ? AND user_id = ?')
      .get(ORG, sam.id);
  return { database, db, operator, sam, member };
}

function subscription(userId: string, patch: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: 'sub_1',
    customerId: 'cus_1',
    status: 'trialing',
    trialEndsAt: 2_000,
    currentPeriodEndsAt: 2_000,
    cancelsAtPeriodEnd: false,
    userId,
    ...patch,
  };
}

describe('a subscription to a space CloudChef runs', () => {
  it('gives the person a place in the managed team while it is in its free month or paid', async () => {
    const { db, sam, member } = await setup();
    await expect(applySubscription(db, config, subscription(sam.id))).resolves.toBe(sam.id);
    expect(member()).toEqual({ role: 'member', paused_at: null });
    await expect(findManagedSubscription(db, sam.id)).resolves.toMatchObject({
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      status: 'trialing',
      trialEndsAt: 2_000,
    });
    await applySubscription(db, config, subscription(sam.id, { status: 'active', trialEndsAt: null }));
    expect(member()).toEqual({ role: 'member', paused_at: null });
  });

  it('pauses the space when a payment fails or it ends, and resumes it when they pay again', async () => {
    const { db, sam, member } = await setup();
    await applySubscription(db, config, subscription(sam.id));
    for (const status of ['past_due', 'unpaid', 'canceled']) {
      await applySubscription(db, config, subscription(sam.id, { status }));
      expect(member()).toMatchObject({ role: 'member', paused_at: expect.any(Number) });
    }
    // A new subscription after the old one ended.
    await applySubscription(db, config, subscription(sam.id, { id: 'sub_2', status: 'active' }));
    expect(member()).toEqual({ role: 'member', paused_at: null });
    await expect(findManagedSubscription(db, sam.id)).resolves.toMatchObject({ subscriptionId: 'sub_2' });
  });

  it("never lifts a pause the team's admin made", async () => {
    const { database, db, sam, member } = await setup();
    await applySubscription(db, config, subscription(sam.id));
    database.prepare('UPDATE organization_members SET paused_at = 77 WHERE user_id = ?').run(sam.id);
    // Stripe reports the same paid subscription again, as it does at every renewal.
    await applySubscription(db, config, subscription(sam.id, { status: 'active' }));
    expect(member()).toEqual({ role: 'member', paused_at: 77 });
    // Nor does a lapse and a payment after it: the admin's pause was there first.
    await applySubscription(db, config, subscription(sam.id, { status: 'past_due' }));
    await applySubscription(db, config, subscription(sam.id, { status: 'active' }));
    expect(member()).toEqual({ role: 'member', paused_at: 77 });
  });

  it("leaves the team's admin alone, whatever their own subscription does", async () => {
    const { database, db, operator } = await setup();
    await applySubscription(db, config, subscription(operator.id, { status: 'canceled' }));
    expect(
      database.prepare('SELECT role, paused_at FROM organization_members WHERE user_id = ?').get(operator.id),
    ).toEqual({ role: 'admin', paused_at: null });
  });

  it("does not end the space when an earlier, replaced subscription's ending arrives late", async () => {
    const { db, sam, member } = await setup();
    await applySubscription(db, config, subscription(sam.id, { status: 'canceled' }));
    await applySubscription(db, config, subscription(sam.id, { id: 'sub_2', status: 'active' }));
    await applySubscription(db, config, subscription(sam.id, { id: 'sub_1', status: 'canceled' }));
    expect(member()).toEqual({ role: 'member', paused_at: null });
    await expect(findManagedSubscription(db, sam.id)).resolves.toMatchObject({
      subscriptionId: 'sub_2',
      status: 'active',
    });
  });

  it('finds the person by the customer made for them, and ignores a subscription that is no one’s', async () => {
    const { db, sam, member } = await setup();
    await expect(recordCustomer(db, sam.id, 'cus_1')).resolves.toBe('cus_1');
    // A second checkout keeps the first customer.
    await expect(recordCustomer(db, sam.id, 'cus_other')).resolves.toBe('cus_1');
    await expect(applySubscription(db, config, subscription('', { userId: null }))).resolves.toBe(sam.id);
    expect(member()).toEqual({ role: 'member', paused_at: null });
    await expect(
      applySubscription(db, config, subscription('', { id: 'sub_x', customerId: 'cus_unknown', userId: 'nobody' })),
    ).resolves.toBeNull();
  });

  it('applies each Stripe delivery once', async () => {
    const { db } = await setup();
    await expect(claimStripeEvent(db, { id: 'evt_1', type: 'customer.subscription.updated' })).resolves.toBe(true);
    await expect(claimStripeEvent(db, { id: 'evt_1', type: 'customer.subscription.updated' })).resolves.toBe(false);
  });
});

describe("a space's monthly building allowance", () => {
  it("prices this month's tokens at the team's default model, cached ones at the cached price", async () => {
    const { database, db, sam } = await setup();
    const now = Date.UTC(2026, 10, 21);
    const add = database.prepare(
      `INSERT INTO organization_usage_daily (org_id, user_id, day, turns, input_tokens, output_tokens, cached_tokens)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    );
    add.run(ORG, sam.id, '2026-11-03', 3_000_000, 1_000_000, 1_000_000);
    // Last month's use is not this month's.
    add.run(ORG, sam.id, '2026-10-30', 90_000_000, 90_000_000, 0);
    const price = piWorkersAiModel(CLOUDFLARE_WORKERS_AI_MODEL)?.cost;
    if (!price) {
      throw new Error("Pi doesn't list the pinned model");
    }
    const usage = await spaceUsage(db, CONNECTION, ORG, sam.id, now);
    expect(usage.usedUsd).toBeCloseTo(2 * price.input + price.cacheRead + price.output, 6);
    expect(usage.allowanceUsd).toBe(MONTHLY_USAGE_ALLOWANCE_USD);
    expect(usage.resetsAt).toBe(Date.UTC(2026, 11, 1));
  });
});
