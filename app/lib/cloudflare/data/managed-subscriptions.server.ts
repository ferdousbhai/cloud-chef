import type { BillingConfig, StripeSubscription } from '~/lib/.server/billing/stripe';
import { piGatewayModel, piWorkersAiModel } from '~/lib/.server/llm/pi-model-catalog';
import { readBuilderModelSettings } from '~/lib/cloudflare/data/builder-model-settings.server';
import { MANAGED_SPACE_MONTHLY_ALLOWANCE_USD } from '~/lib/managed-space';
import { effectiveDefaultModelId } from '~/lib/workers-ai-model';

/**
 * Subscriptions to a space CloudChef runs (`migrations/0068_managed_subscriptions.sql`). A space is a
 * membership of one team in CloudChef's own Cloudflare account (`MANAGED_SPACE_ORG_ID`): a subscription
 * in good standing adds the person to it, one that lapses pauses them there, and paying again resumes
 * them. Everything a team member is and is kept from (`canUseConnection`, their own workspace runtime,
 * `cf` reads refused) holds for them unchanged.
 */
export type ManagedSubscription = {
  userId: string;
  customerId: string;
  subscriptionId: string | null;
  status: string;
  trialEndsAt: number | null;
  currentPeriodEndsAt: number | null;
  cancelsAtPeriodEnd: boolean;
};

type SubscriptionRow = {
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  status: string;
  trial_ends_at: number | null;
  current_period_ends_at: number | null;
  cancels_at_period_end: number;
};

const COLUMNS = `user_id, stripe_customer_id, stripe_subscription_id, status, trial_ends_at, current_period_ends_at,
  cancels_at_period_end`;

function fromRow(row: SubscriptionRow): ManagedSubscription {
  return {
    userId: row.user_id,
    customerId: row.stripe_customer_id,
    subscriptionId: row.stripe_subscription_id,
    status: row.status,
    trialEndsAt: row.trial_ends_at,
    currentPeriodEndsAt: row.current_period_ends_at,
    cancelsAtPeriodEnd: row.cancels_at_period_end === 1,
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
 * Makes the person's membership of the managed team match their subscription. A pause billing makes is
 * marked on the subscription (`space_paused_at`), so paying again lifts only that pause and never one an
 * admin made; an admin of the team is never touched.
 */
async function syncSpace(db: D1Database, orgId: string, userId: string, hasSpace: boolean, now: number): Promise<void> {
  if (hasSpace) {
    await db.batch([
      db
        .prepare(
          `INSERT INTO organization_members (org_id, user_id, role, joined_at, drafts_allowed)
           SELECT id, ?2, 'member', ?3, 1 FROM organizations WHERE id = ?1
           ON CONFLICT(org_id, user_id) DO NOTHING`,
        )
        .bind(orgId, userId, now),
      db
        .prepare(
          `UPDATE organization_members SET paused_at = NULL
           WHERE org_id = ?1 AND user_id = ?2 AND role = 'member'
             AND EXISTS (SELECT 1 FROM managed_subscriptions WHERE user_id = ?2 AND space_paused_at IS NOT NULL)`,
        )
        .bind(orgId, userId),
      db.prepare('UPDATE managed_subscriptions SET space_paused_at = NULL WHERE user_id = ?').bind(userId),
    ]);
    return;
  }
  await db.batch([
    db
      .prepare(
        `UPDATE managed_subscriptions SET space_paused_at = ?3
         WHERE user_id = ?2 AND space_paused_at IS NULL
           AND EXISTS (SELECT 1 FROM organization_members
                       WHERE org_id = ?1 AND user_id = ?2 AND role = 'member' AND paused_at IS NULL)`,
      )
      .bind(orgId, userId, now),
    db
      .prepare(
        `UPDATE organization_members SET paused_at = ?3
         WHERE org_id = ?1 AND user_id = ?2 AND role = 'member' AND paused_at IS NULL`,
      )
      .bind(orgId, userId, now),
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

export type SpaceUsage = { usedUsd: number; allowanceUsd: number; resetsAt: number };

/**
 * What the person's building in the managed team cost so far this month, against the month's allowance: their
 * builder turns' tokens at the list price of the team's default model (its admin should allow no dearer one),
 * and their workspace container's running time. Both come from `organization_usage_daily`, which every finished
 * turn and every stretch of container time adds to.
 */
export async function spaceUsage(
  db: D1Database,
  managedConnectionId: string,
  orgId: string,
  userId: string,
  now = Date.now(),
): Promise<SpaceUsage> {
  const today = new Date(now);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const nextMonth = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
  const [counts, { defaultModelId }] = await Promise.all([
    db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cached_tokens), 0) AS cached, COALESCE(SUM(container_seconds), 0) AS containerSeconds
         FROM organization_usage_daily WHERE org_id = ? AND user_id = ? AND day >= ?`,
      )
      .bind(orgId, userId, monthStart.toISOString().slice(0, 10))
      .first<{ input: number; output: number; cached: number; containerSeconds: number }>(),
    readBuilderModelSettings(db, managedConnectionId),
  ]);
  const modelId = effectiveDefaultModelId(defaultModelId);
  const price = piWorkersAiModel(modelId)?.cost ?? piGatewayModel(modelId)?.model.cost;
  const used = counts ?? { input: 0, output: 0, cached: 0, containerSeconds: 0 };
  // Dollars per million tokens. Cached tokens are counted among the input ones.
  const modelUsd = price
    ? ((used.input - used.cached) * price.input + used.cached * price.cacheRead + used.output * price.output) /
      1_000_000
    : 0;
  const usedUsd = modelUsd + used.containerSeconds * CONTAINER_USD_PER_SECOND;
  return { usedUsd, allowanceUsd: MONTHLY_USAGE_ALLOWANCE_USD, resetsAt: nextMonth };
}
