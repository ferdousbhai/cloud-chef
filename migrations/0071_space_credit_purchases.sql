-- Building credit bought for a space CloudChef runs: one row per paid Stripe checkout, whose id is the key, so a
-- purchase reported twice (the return from checkout and the webhook) counts once. Credit is used after a month's
-- included allowance and carries over; what is left is what was bought less every month's use beyond the allowance.
CREATE TABLE space_credit_purchases (
  checkout_session_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Who bought it; kept as bought when their account is erased.
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  amount_usd INTEGER NOT NULL CHECK (amount_usd > 0),
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX idx_space_credit_purchases_org ON space_credit_purchases(org_id);
