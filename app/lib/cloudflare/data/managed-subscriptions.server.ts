import type { BillingConfig, StripeSubscription } from '~/lib/.server/billing/stripe';
import { piGatewayModel, piWorkersAiModel } from '~/lib/.server/llm/pi-model-catalog';
import { readBuilderModelSettings } from '~/lib/cloudflare/data/builder-model-settings.server';
import { MANAGED_SPACE_CREDIT_PRICE_RATIO, MANAGED_SPACE_MONTHLY_ALLOWANCE_USD } from '~/lib/managed-space';
import { effectiveDefaultModelId } from '~/lib/workers-ai-model';
import { spaceNameFor } from '~/lib/workspace-name';

/**
 * Subscriptions to a space CloudChef runs (`migrations/0068_managed_subscriptions.sql`, `0070_managed_spaces.sql`).
 * A space is a team of the subscriber's own that builds in the operator's Cloudflare account, the one the host
 * team (`MANAGED_SPACE_ORG_ID`) is connected to: the first subscription in good standing makes it, with its
 * subscriber as the admin who runs it and may invite people into it; one that lapses pauses everyone in it, and
 * paying again resumes them. Nobody in a space has an admin's powers over the Cloudflare account
 * (`isActiveAdmin`), and everything a team member is kept from (`canUseConnection`, their own workspace runtime,
 * `cf` reads refused) holds for all of them.
 */
export type ManagedSubscription = {
  userId: string;
  customerId: string;
  subscriptionId: string | null;
  status: string;
  trialEndsAt: number | null;
  currentPeriodEndsAt: number | null;
  cancelsAtPeriodEnd: boolean;
  /** The space this subscription gave them; null before the first one in good standing. */
  spaceOrgId: string | null;
  /** How many people the subscription pays for: everyone in the space, as last counted. */
  seats: number;
};

type SubscriptionRow = {
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  status: string;
  trial_ends_at: number | null;
  current_period_ends_at: number | null;
  cancels_at_period_end: number;
  space_org_id: string | null;
  seats: number;
};

const COLUMNS = `user_id, stripe_customer_id, stripe_subscription_id, status, trial_ends_at, current_period_ends_at,
  cancels_at_period_end, space_org_id, seats`;

function fromRow(row: SubscriptionRow): ManagedSubscription {
  return {
    userId: row.user_id,
    customerId: row.stripe_customer_id,
    subscriptionId: row.stripe_subscription_id,
    status: row.status,
    trialEndsAt: row.trial_ends_at,
    currentPeriodEndsAt: row.current_period_ends_at,
    cancelsAtPeriodEnd: row.cancels_at_period_end === 1,
    spaceOrgId: row.space_org_id,
    seats: row.seats,
  };
}

/** Stripe's states in which the person has paid, or is in their free month: they have a space. */
export function givesSpace(status: string): boolean {
  return status === 'trialing' || status === 'active';
}

export async function findManagedSubscription(db: D1Database, userId: string): Promise<ManagedSubscription | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM managed_subscriptions WHERE user_id = ?`)
    .bind(userId)
    .first<SubscriptionRow>();
  return row ? fromRow(row) : null;
}

/** Records the Stripe customer made for this person before their first checkout; an earlier one is kept. */
export async function recordCustomer(db: D1Database, userId: string, customerId: string): Promise<string> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO managed_subscriptions (user_id, stripe_customer_id, status, created_at, updated_at)
       VALUES (?, ?, 'none', ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET updated_at = managed_subscriptions.updated_at
       RETURNING stripe_customer_id`,
    )
    .bind(userId, customerId, now, now)
    .first<{ stripe_customer_id: string }>();
  return row?.stripe_customer_id ?? customerId;
}

/**
 * Records what Stripe says about a subscription and gives, pauses or resumes the person's space to
 * match. The person is whoever holds its customer, or else the user its metadata names; a subscription
 * for neither changes nothing. Returns the person, or null.
 */
export async function applySubscription(
  db: D1Database,
  config: BillingConfig,
  subscription: StripeSubscription,
): Promise<string | null> {
  const now = Date.now();
  const owner = await db
    .prepare(
      `SELECT user_id FROM managed_subscriptions WHERE stripe_customer_id = ?1
       UNION ALL SELECT id FROM "user" WHERE id = ?2
       LIMIT 1`,
    )
    .bind(subscription.customerId, subscription.userId ?? '')
    .first<{ user_id: string }>();
  if (!owner) {
    return null;
  }
  const userId = owner.user_id;
  // A person has one subscription. A second one's ending (an earlier, cancelled one) must not end the space the
  // current one gives, so only the recorded subscription, or a live one replacing a dead one, is written.
  await db
    .prepare(
      `INSERT INTO managed_subscriptions
         (user_id, stripe_customer_id, stripe_subscription_id, status, trial_ends_at, current_period_ends_at,
          cancels_at_period_end, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT(user_id) DO UPDATE SET
         stripe_subscription_id = excluded.stripe_subscription_id, status = excluded.status,
         trial_ends_at = excluded.trial_ends_at, current_period_ends_at = excluded.current_period_ends_at,
         cancels_at_period_end = excluded.cancels_at_period_end, updated_at = excluded.updated_at
       WHERE managed_subscriptions.stripe_subscription_id IS NULL
          OR managed_subscriptions.stripe_subscription_id = excluded.stripe_subscription_id
          OR (managed_subscriptions.status NOT IN ('trialing', 'active') AND excluded.status IN ('trialing', 'active'))`,
    )
    .bind(
      userId,
      subscription.customerId,
      subscription.id,
      subscription.status,
      subscription.trialEndsAt,
      subscription.currentPeriodEndsAt,
      subscription.cancelsAtPeriodEnd ? 1 : 0,
      now,
    )
    .run();
  const recorded = await findManagedSubscription(db, userId);
  if (recorded) {
    await syncSpace(db, config.managedOrgId, userId, givesSpace(recorded.status), now);
  }
  return userId;
}

/**
 * Makes the person's space match their subscription: made the first time it is in good standing, everyone in it
 * paused while it isn't, and resumed when it is again. A pause billing makes carries the time on the subscription
 * (`space_paused_at`), so paying again lifts exactly those pauses and never one the space's own admin made.
 */
async function syncSpace(
  db: D1Database,
  hostOrgId: string,
  userId: string,
  hasSpace: boolean,
  now: number,
): Promise<void> {
  const theirSpace = '(SELECT space_org_id FROM managed_subscriptions WHERE user_id = ?1)';
  const pausedByBilling = '(SELECT space_paused_at FROM managed_subscriptions WHERE user_id = ?1)';
  if (hasSpace) {
    await makeSpace(db, hostOrgId, userId, now);
    await db.batch([
      db
        .prepare(
          `UPDATE organization_members SET paused_at = NULL WHERE org_id = ${theirSpace} AND paused_at = ${pausedByBilling}`,
        )
        .bind(userId),
      db.prepare('UPDATE managed_subscriptions SET space_paused_at = NULL WHERE user_id = ?').bind(userId),
    ]);
    return;
  }
  await db.batch([
    db
      .prepare(
        `UPDATE managed_subscriptions SET space_paused_at = ?2
         WHERE user_id = ?1 AND space_paused_at IS NULL AND space_org_id IS NOT NULL`,
      )
      .bind(userId, now),
    db
      .prepare(
        `UPDATE organization_members SET paused_at = ${pausedByBilling}
         WHERE org_id = ${theirSpace} AND paused_at IS NULL AND ${pausedByBilling} IS NOT NULL`,
      )
      .bind(userId),
  ]);
}

/** The subscription row has no space: none was made yet, or the one made was since deleted. */
const NO_SPACE = `(space_org_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM organizations WHERE organizations.id = managed_subscriptions.space_org_id))`;

/**
 * Makes the subscriber's space unless they have one: a team named for them, with them as its admin, and its own
 * connection to the Cloudflare account the host team is connected to. All of it or none, in one write, so two
 * deliveries about the same subscription make one space; none while the host team's account isn't connected.
 */
async function makeSpace(db: D1Database, hostOrgId: string, userId: string, now: number): Promise<void> {
  const person = await db.prepare('SELECT name FROM "user" WHERE id = ?').bind(userId).first<{ name: string }>();
  const orgId = crypto.randomUUID();
  const made = 'EXISTS (SELECT 1 FROM organizations WHERE id = ?1)';
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, created_by, created_at, updated_at, managed_host_org_id)
         SELECT ?1, ?2, ?3, ?4, ?4, host.org_id FROM cloudflare_connections AS host
         WHERE host.org_id = ?5 AND host.status = 'active'
           AND EXISTS (SELECT 1 FROM managed_subscriptions WHERE user_id = ?3 AND ${NO_SPACE})`,
      )
      .bind(orgId, spaceNameFor(person?.name ?? ''), userId, now, hostOrgId),
    db
      .prepare(
        `INSERT INTO organization_members (org_id, user_id, role, joined_at, drafts_allowed)
         SELECT ?1, ?2, 'admin', ?3, 1 WHERE ${made}`,
      )
      .bind(orgId, userId, now),
    db
      .prepare(
        `INSERT INTO cloudflare_connections (id, org_id, account_id, account_name, status, connected_at, created_at, updated_at)
         SELECT ?2, ?1, host.account_id, 'CloudChef', 'active', ?3, ?3, ?3 FROM cloudflare_connections AS host
         WHERE host.org_id = ?4 AND ${made}`,
      )
      .bind(orgId, crypto.randomUUID(), now, hostOrgId),
    db
      .prepare(
        `UPDATE managed_subscriptions SET space_org_id = ?1 WHERE user_id = ?2 AND space_org_id IS NOT ?1 AND ${made}`,
      )
      .bind(orgId, userId),
  ]);
}

/** A webhook delivery is applied once: false when this event was already recorded. */
export async function claimStripeEvent(db: D1Database, event: { id: string; type: string }): Promise<boolean> {
  const result = await db
    .prepare('INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(event.id, event.type, Date.now())
    .run();
  return result.meta.changes === 1;
}

/** Lets a delivery whose handling failed be applied when Stripe sends it again. */
export async function releaseStripeEvent(db: D1Database, eventId: string): Promise<void> {
  await db.prepare('DELETE FROM stripe_events WHERE id = ?').bind(eventId).run();
}

/**
 * What a space may use in a calendar month (UTC): the builder's model at its list price and the workspace
 * container's running time at Cloudflare's, together. It is less than the plan's price; Stripe's fee and what their
 * published applications use are not counted in it and are paid from the difference.
 */
export const MONTHLY_USAGE_ALLOWANCE_USD = MANAGED_SPACE_MONTHLY_ALLOWANCE_USD;

/**
 * What a second of the workspace container costs: `standard-4`'s 12 GiB of memory ($0.0000025 a GiB-second) and
 * 20 GB of disk ($0.00000007 a GB-second), which Cloudflare bills as provisioned while the container runs, and
 * one of its four vCPUs ($0.000020 a vCPU-second), which it bills only as used; one busy core on average is on
 * the dear side of what building uses. About 19 cents an hour. The account's included usage is not taken off.
 */
export const CONTAINER_USD_PER_SECOND = 12 * 0.0000025 + 20 * 0.00000007 + 0.00002;

export type SpaceUsage = {
  usedUsd: number;
  allowanceUsd: number;
  /** Bought credit not yet used: building draws on it once the month's allowance is used. */
  creditUsd: number;
  resetsAt: number;
};

/** Whether the allowance and any bought credit are both used: nothing more may be built this month. */
export function allowanceUsed(usage: SpaceUsage): boolean {
  return usage.usedUsd >= usage.allowanceUsd && usage.creditUsd <= 0;
}

type MonthUse = { month: string; input: number; output: number; cached: number; containerSeconds: number };

/**
 * What building in the team `orgId` cost so far this month, against the month's allowance: everyone's in it, or
 * `userId`'s alone. Builder turns' tokens are priced at the list price of the default model of the connection
 * `connectionId` (the host team's for a space; its admins should allow no dearer one), and the workspace
 * containers' running time at Cloudflare's. Both come from `organization_usage_daily`, which every finished turn
 * and every stretch of container time adds to.
 *
 * A space's bought credit is what was bought less what every month, this one included, used beyond its
 * allowance, at today's prices times the credit's margin (`MANAGED_SPACE_CREDIT_PRICE_RATIO`): nothing is written as credit is used, so there is no balance to drift.
 */
export async function spaceUsage(
  db: D1Database,
  connectionId: string,
  orgId: string,
  userId: string | null,
  now = Date.now(),
): Promise<SpaceUsage> {
  const today = new Date(now);
  const thisMonth = today.toISOString().slice(0, 7);
  const nextMonth = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
  const [months, bought, pooled, { defaultModelId }] = await Promise.all([
    db
      .prepare(
        `SELECT substr(day, 1, 7) AS month, COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cached_tokens), 0) AS cached,
                COALESCE(SUM(container_seconds), 0) AS containerSeconds
         FROM organization_usage_daily WHERE org_id = ?1 AND (?2 IS NULL OR user_id = ?2)
         GROUP BY month`,
      )
      .bind(orgId, userId)
      .all<MonthUse>(),
    // Credit is the whole space's, never one member's.
    userId === null
      ? db
          .prepare('SELECT COALESCE(SUM(amount_usd), 0) AS usd FROM space_credit_purchases WHERE org_id = ?')
          .bind(orgId)
          .first<{ usd: number }>()
      : null,
    userId === null ? spaceAllowances(db, orgId) : null,
    readBuilderModelSettings(db, connectionId),
  ]);
  // A space's allowance is everyone's in it together; anywhere else it is one person's.
  const allowanceOf = (month: string): number =>
    pooled
      ? (pooled.months.get(month) ?? (month === thisMonth ? pooled.seats : 1) * MONTHLY_USAGE_ALLOWANCE_USD * 100) / 100
      : MONTHLY_USAGE_ALLOWANCE_USD;
  const modelId = effectiveDefaultModelId(defaultModelId);
  const price = piWorkersAiModel(modelId)?.cost ?? piGatewayModel(modelId)?.model.cost;
  // Dollars per million tokens. Cached tokens are counted among the input ones.
  const cost = (used: MonthUse) =>
    (price
      ? ((used.input - used.cached) * price.input + used.cached * price.cacheRead + used.output * price.output) /
        1_000_000
      : 0) +
    used.containerSeconds * CONTAINER_USD_PER_SECOND;
  let usedUsd = 0;
  let overAllowanceUsd = 0;
  for (const month of months.results) {
    const monthUsd = cost(month);
    overAllowanceUsd += Math.max(0, monthUsd - allowanceOf(month.month));
    if (month.month === thisMonth) {
      usedUsd = monthUsd;
    }
  }
  return {
    usedUsd,
    allowanceUsd: allowanceOf(thisMonth),
    creditUsd: Math.max(0, (bought?.usd ?? 0) - overAllowanceUsd * MANAGED_SPACE_CREDIT_PRICE_RATIO),
    resetsAt: nextMonth,
  };
}

/** A space's people now, and the allowance of each month in which their number changed, in cents. */
async function spaceAllowances(db: D1Database, orgId: string): Promise<{ seats: number; months: Map<string, number> }> {
  const [subscription, { results }] = await Promise.all([
    db.prepare('SELECT seats FROM managed_subscriptions WHERE space_org_id = ?').bind(orgId).first<{ seats: number }>(),
    db
      .prepare('SELECT month, allowance_cents FROM space_month_allowances WHERE org_id = ?')
      .bind(orgId)
      .all<{ month: string; allowance_cents: number }>(),
  ]);
  return {
    seats: subscription?.seats ?? 1,
    months: new Map(results.map((row) => [row.month, row.allowance_cents])),
  };
}

/**
 * Counts the people in a space again and makes its subscription's seats that number, with this month's
 * allowance moved by the plan's allowance for the part of the month that is left, once for each person who
 * joined and back for each who left: the same share of the month Stripe charges or credits the subscriber for
 * them. One write, so two people joining at once are both counted. Returns the subscription to set to that many
 * seats at Stripe, or null when the team is not a space with a subscription.
 */
export async function countSpaceSeats(
  db: D1Database,
  orgId: string,
  now = Date.now(),
): Promise<{ subscriptionId: string | null; status: string; seats: number } | null> {
  const today = new Date(now);
  const monthStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
  const nextMonth = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
  const perSeatCents = MONTHLY_USAGE_ALLOWANCE_USD * 100;
  const restOfMonthCents = Math.round((perSeatCents * (nextMonth - now)) / (nextMonth - monthStart));
  const people = '(SELECT MAX(1, COUNT(*)) FROM organization_members WHERE org_id = ?1)';
  const seats = '(SELECT seats FROM managed_subscriptions WHERE space_org_id = ?1)';
  await db.batch([
    // The month starts with the allowance of the people there were before any change in it.
    db
      .prepare(
        `INSERT INTO space_month_allowances (org_id, month, allowance_cents)
         SELECT ?1, ?2, seats * ?3 FROM managed_subscriptions WHERE space_org_id = ?1
         ON CONFLICT(org_id, month) DO NOTHING`,
      )
      .bind(orgId, today.toISOString().slice(0, 7), perSeatCents),
    db
      .prepare(
        `UPDATE space_month_allowances SET allowance_cents = MAX(0, allowance_cents + (${people} - ${seats}) * ?3)
         WHERE org_id = ?1 AND month = ?2 AND ${seats} IS NOT NULL`,
      )
      .bind(orgId, today.toISOString().slice(0, 7), restOfMonthCents),
    db
      .prepare(`UPDATE managed_subscriptions SET seats = ${people} WHERE space_org_id = ?1 AND seats <> ${people}`)
      .bind(orgId),
  ]);
  const row = await db
    .prepare('SELECT seats, stripe_subscription_id, status FROM managed_subscriptions WHERE space_org_id = ?')
    .bind(orgId)
    .first<{ seats: number; stripe_subscription_id: string | null; status: string }>();
  return row ? { subscriptionId: row.stripe_subscription_id, status: row.status, seats: row.seats } : null;
}

/**
 * Records a paid purchase of building credit for a space CloudChef runs, once however often it is reported.
 * False when it was already recorded, or the space is gone.
 */
export async function recordCreditPurchase(
  db: D1Database,
  purchase: { id: string; orgId: string; userId: string | null; amountUsd: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO space_credit_purchases (checkout_session_id, org_id, user_id, amount_usd, created_at)
       SELECT ?1, organizations.id, (SELECT id FROM "user" WHERE id = ?3), ?4, ?5 FROM organizations
       WHERE organizations.id = ?2 AND organizations.managed_host_org_id IS NOT NULL
       ON CONFLICT(checkout_session_id) DO NOTHING`,
    )
    .bind(purchase.id, purchase.orgId, purchase.userId, purchase.amountUsd, Date.now())
    .run();
  return result.meta.changes === 1;
}
