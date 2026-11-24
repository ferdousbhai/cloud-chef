import { describe, expect, it } from 'vitest';
import type { BillingConfig, StripeSubscription } from '~/lib/.server/billing/stripe';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { piWorkersAiModel } from '~/lib/.server/llm/pi-model-catalog';
import { controlPlaneDatabase, createProvenEmailUser } from '~/test/control-plane-d1';
import { findMembership, isActiveAdmin, runsTeam } from './organization-access.server';
import {
  allowanceUsed,
  applySubscription,
  CONTAINER_USD_PER_SECOND,
  claimStripeEvent,
  findManagedSubscription,
  MONTHLY_USAGE_ALLOWANCE_USD,
  recordCreditPurchase,
  recordCustomer,
  spaceUsage,
} from './managed-subscriptions.server';

const ORG = 'managed-org';
const CONNECTION = 'managed-connection';
const config: BillingConfig = {
  secretKey: 'sk_test',
  webhookSecret: 'whsec',
  priceId: 'price_1',
  portalConfigurationId: null,
  creditPriceIds: {},
  managedOrgId: ORG,
};

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
  /** Sam's space, once a subscription made it: the team, its connection, and everyone in it. */
  const space = () => {
    const team = database
      .prepare(
        `SELECT organizations.id, organizations.name, organizations.managed_host_org_id AS host,
                connections.id AS connection, connections.account_id AS account, connections.status
         FROM managed_subscriptions AS subscriptions
         JOIN organizations ON organizations.id = subscriptions.space_org_id
         LEFT JOIN cloudflare_connections AS connections ON connections.org_id = organizations.id
         WHERE subscriptions.user_id = ?`,
      )
      .get(sam.id);
    return team ?? null;
  };
  const members = () =>
    database
      .prepare(
        `SELECT members.user_id, members.role, members.paused_at FROM organization_members AS members
         JOIN managed_subscriptions AS subscriptions ON subscriptions.space_org_id = members.org_id
         WHERE subscriptions.user_id = ? ORDER BY members.joined_at, members.user_id`,
      )
      .all(sam.id);
  return { database, db, operator, sam, space, members };
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
  it("makes the person a space of their own in the host team's Cloudflare account, which they run", async () => {
    const { database, db, sam, space, members } = await setup();
    await expect(applySubscription(db, config, subscription(sam.id))).resolves.toBe(sam.id);
    const made = space();
    expect(made).toMatchObject({ name: 'sam’s space', host: ORG, account: 'account-1', status: 'active' });
    expect(members()).toEqual([{ user_id: sam.id, role: 'admin', paused_at: null }]);
    // They run the team, and nobody in it runs the Cloudflare account.
    const membership = await findMembership(db, String(made?.id), sam.id);
    expect(runsTeam(membership)).toBe(true);
    expect(isActiveAdmin(membership)).toBe(false);
    // The host team is as it was: they are no member of it.
    expect(database.prepare('SELECT user_id FROM organization_members WHERE org_id = ?').all(ORG)).toHaveLength(1);
    await expect(findManagedSubscription(db, sam.id)).resolves.toMatchObject({
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      status: 'trialing',
      trialEndsAt: 2_000,
      spaceOrgId: made?.id,
    });
    // Stripe says the same again at every renewal: still the one space.
    await applySubscription(db, config, subscription(sam.id, { status: 'active', trialEndsAt: null }));
    expect(space()).toEqual(made);
    expect(database.prepare('SELECT COUNT(*) AS spaces FROM organizations').get()).toEqual({ spaces: 2 });
  });

  it('makes no space while the host team has no Cloudflare account connected, and makes it once it has', async () => {
    const { database, db, sam, space } = await setup();
    database.prepare("UPDATE cloudflare_connections SET status = 'revoked' WHERE org_id = ?").run(ORG);
    await applySubscription(db, config, subscription(sam.id));
    expect(space()).toBeNull();
    database.prepare("UPDATE cloudflare_connections SET status = 'active' WHERE org_id = ?").run(ORG);
    await applySubscription(db, config, subscription(sam.id, { status: 'active' }));
    expect(space()).toMatchObject({ host: ORG });
  });

  it('pauses everyone in the space when a payment fails or it ends, and resumes them when it is paid again', async () => {
    const { database, db, operator, sam, space, members } = await setup();
    await applySubscription(db, config, subscription(sam.id));
    const spaceId = String(space()?.id);
    // Someone Sam invited, and someone Sam paused themselves.
    const guest = await createProvenEmailUser(db, 'guest@example.com');
    const add = database.prepare(
      "INSERT INTO organization_members (org_id, user_id, role, joined_at, paused_at) VALUES (?, ?, 'member', 5, ?)",
    );
    add.run(spaceId, guest.id, null);
    add.run(spaceId, operator.id, 77);
    for (const status of ['past_due', 'unpaid', 'canceled']) {
      await applySubscription(db, config, subscription(sam.id, { status }));
      expect(members().filter((member) => member.paused_at === null)).toEqual([]);
      expect(members()).toHaveLength(3);
    }
    // A new subscription after the old one ended: the same space, and only billing's pauses are lifted.
    await applySubscription(db, config, subscription(sam.id, { id: 'sub_2', status: 'active' }));
    expect(space()?.id).toBe(spaceId);
    expect(members()).toEqual(
      expect.arrayContaining([
        { user_id: sam.id, role: 'admin', paused_at: null },
        { user_id: guest.id, role: 'member', paused_at: null },
        { user_id: operator.id, role: 'member', paused_at: 77 },
      ]),
    );
    await expect(findManagedSubscription(db, sam.id)).resolves.toMatchObject({ subscriptionId: 'sub_2' });
  });

  it("does not end the space when an earlier, replaced subscription's ending arrives late", async () => {
    const { db, sam, members } = await setup();
    await applySubscription(db, config, subscription(sam.id, { status: 'canceled' }));
    expect(members()).toEqual([]);
    await applySubscription(db, config, subscription(sam.id, { id: 'sub_2', status: 'active' }));
    await applySubscription(db, config, subscription(sam.id, { id: 'sub_1', status: 'canceled' }));
    expect(members()).toEqual([{ user_id: sam.id, role: 'admin', paused_at: null }]);
    await expect(findManagedSubscription(db, sam.id)).resolves.toMatchObject({
      subscriptionId: 'sub_2',
      status: 'active',
    });
  });

  it('finds the person by the customer made for them, and ignores a subscription that is no one’s', async () => {
    const { db, sam, members } = await setup();
    await expect(recordCustomer(db, sam.id, 'cus_1')).resolves.toBe('cus_1');
    // A second checkout keeps the first customer.
    await expect(recordCustomer(db, sam.id, 'cus_other')).resolves.toBe('cus_1');
    await expect(applySubscription(db, config, subscription('', { userId: null }))).resolves.toBe(sam.id);
    expect(members()).toEqual([{ user_id: sam.id, role: 'admin', paused_at: null }]);
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
  it("prices this month's tokens at the team's default model, cached ones at the cached price, and adds the container's time", async () => {
    const { database, db, sam } = await setup();
    const now = Date.UTC(2026, 10, 21);
    const add = database.prepare(
      `INSERT INTO organization_usage_daily (org_id, user_id, day, turns, input_tokens, output_tokens, cached_tokens)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    );
    add.run(ORG, sam.id, '2026-11-03', 3_000_000, 1_000_000, 1_000_000);
    // Last month's use is not this month's.
    add.run(ORG, sam.id, '2026-10-30', 90_000_000, 90_000_000, 0);
    // Two hours of the workspace container this month, and some last month.
    const ran = database.prepare(
      `INSERT INTO organization_usage_daily (org_id, user_id, day, container_seconds) VALUES (?, ?, ?, ?)`,
    );
    ran.run(ORG, sam.id, '2026-11-04', 7_200);
    ran.run(ORG, sam.id, '2026-10-29', 500_000);
    const price = piWorkersAiModel(CLOUDFLARE_WORKERS_AI_MODEL)?.cost;
    if (!price) {
      throw new Error("Pi doesn't list the pinned model");
    }
    // Someone else in the same team, whose use counts when the whole team's is asked for.
    const guest = await createProvenEmailUser(db, 'guest@example.com');
    ran.run(ORG, guest.id, '2026-11-05', 3_600);
    await expect(spaceUsage(db, CONNECTION, ORG, null, now)).resolves.toMatchObject({
      usedUsd: expect.closeTo(2 * price.input + price.cacheRead + price.output + 10_800 * CONTAINER_USD_PER_SECOND, 6),
    });
    const usage = await spaceUsage(db, CONNECTION, ORG, sam.id, now);
    expect(usage.usedUsd).toBeCloseTo(
      2 * price.input + price.cacheRead + price.output + 7_200 * CONTAINER_USD_PER_SECOND,
      6,
    );
    // About 19 cents an hour.
    expect(CONTAINER_USD_PER_SECOND * 3_600).toBeCloseTo(0.185, 3);
    expect(usage.allowanceUsd).toBe(MONTHLY_USAGE_ALLOWANCE_USD);
    expect(usage.resetsAt).toBe(Date.UTC(2026, 11, 1));
  });

  it('draws on bought credit once a month is past its allowance, and keeps what is left for later months', async () => {
    const { database, db, sam, space } = await setup();
    await applySubscription(db, config, subscription(sam.id, { status: 'active' }));
    const spaceId = String(space()?.id);
    const connectionId = String(space()?.connection);
    const hours = (dollars: number) => Math.round(dollars / CONTAINER_USD_PER_SECOND);
    const ran = database.prepare(
      'INSERT INTO organization_usage_daily (org_id, user_id, day, container_seconds) VALUES (?, ?, ?, ?)',
    );
    const usage = (now: number) => spaceUsage(db, connectionId, spaceId, null, now);
    const october = Date.UTC(2026, 9, 20);
    const november = Date.UTC(2026, 10, 20);
    // October used $25 of building: $5 beyond the allowance, with no credit to draw on.
    ran.run(spaceId, sam.id, '2026-10-10', hours(25));
    const before = await usage(october);
    expect(before.creditUsd).toBe(0);
    expect(allowanceUsed(before)).toBe(true);
    // $50 of credit, reported twice (the return from checkout and the webhook), counts once.
    const purchase = { id: 'cs_1', orgId: spaceId, userId: sam.id, amountUsd: 50 };
    await expect(recordCreditPurchase(db, purchase)).resolves.toBe(true);
    await expect(recordCreditPurchase(db, purchase)).resolves.toBe(false);
    const topped = await usage(october);
    // Building beyond the allowance takes one and a half times its cost from credit: $7.50 for October's $5.
    expect(topped.creditUsd).toBeCloseTo(42.5, 1);
    expect(allowanceUsed(topped)).toBe(false);
    // November starts with its own allowance and the credit left; $30 of building takes $15 more of it.
    ran.run(spaceId, sam.id, '2026-11-05', hours(30));
    const later = await usage(november);
    expect(later.usedUsd).toBeCloseTo(30, 1);
    expect(later.creditUsd).toBeCloseTo(27.5, 1);
    expect(allowanceUsed(later)).toBe(false);
    // Credit is only ever a space's: none is recorded for a team that is not one.
    await expect(recordCreditPurchase(db, { ...purchase, id: 'cs_2', orgId: ORG })).resolves.toBe(false);
  });
});
