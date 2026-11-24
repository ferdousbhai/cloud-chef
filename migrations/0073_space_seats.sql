-- A space CloudChef runs is paid for by the person, as Google Workspace is: its subscriber pays the plan's price
-- for everyone in it, themselves included. `seats` is the number of people the subscription was last set to.
ALTER TABLE managed_subscriptions ADD COLUMN seats INTEGER NOT NULL DEFAULT 1;

-- A space's building allowance for a calendar month (UTC, 'YYYY-MM'), which everyone in it shares: the plan's
-- allowance for each person there when the month began, plus, for each person who joined during it, the share
-- of it for the part of the month that was left, and less the same share for each who left: what the
-- subscriber is charged and credited for them. A month with no row had no change of people.
CREATE TABLE space_month_allowances (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  allowance_cents INTEGER NOT NULL CHECK (allowance_cents >= 0),
  PRIMARY KEY (org_id, month)
) WITHOUT ROWID;
