-- A person's subscription to a space CloudChef runs: who pays, as Stripe knows them, and what Stripe last said about
-- it. One row per person, kept after a subscription ends so a second one starts without another free month.
-- `space_paused_at` is set while the subscription is why their membership of the managed team is paused, so paying
-- again resumes only a pause billing made, never one an admin made. No card details are stored: Stripe holds them.
-- Erasing the account cancels the subscription at Stripe, then deletes this row with the account.
CREATE TABLE managed_subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  -- Stripe's own word for it (trialing, active, past_due, canceled, unpaid, incomplete, incomplete_expired, paused),
  -- or 'none' before the first checkout completes.
  status TEXT NOT NULL,
  trial_ends_at INTEGER,
  current_period_ends_at INTEGER,
  cancels_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancels_at_period_end IN (0, 1)),
  space_paused_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Stripe webhook deliveries already applied, so a redelivery changes nothing.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
) WITHOUT ROWID;
