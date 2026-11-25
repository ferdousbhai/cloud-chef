-- CloudChef no longer runs spaces in its operator's Cloudflare account (0068 to 0073): a space builds in a Cloudflare
-- account its own admins connected, and nowhere else. The spaces made by subscription (`managed_host_org_id` set)
-- are closed: their connection to the operator's account is revoked, so nothing builds or publishes through it,
-- everyone in them is paused, so nobody there is an admin of anything, and invites into them stop working. Their
-- projects' records stay, and what they published keeps running until the operator removes it.
UPDATE cloudflare_connections
SET status = 'revoked', updated_at = unixepoch() * 1000
WHERE org_id IN (SELECT id FROM organizations WHERE managed_host_org_id IS NOT NULL);

UPDATE organization_members
SET paused_at = unixepoch() * 1000
WHERE paused_at IS NULL AND org_id IN (SELECT id FROM organizations WHERE managed_host_org_id IS NOT NULL);

DELETE FROM organization_invites
WHERE org_id IN (SELECT id FROM organizations WHERE managed_host_org_id IS NOT NULL);

-- Before a subscription gave its person a space of their own (0070), it gave them a place in the host team itself,
-- the operator's own (`MANAGED_SPACE_ORG_ID` then). Anyone still there by subscription is paused too, which its admin
-- can undo for the people they mean to keep.
UPDATE organization_members
SET paused_at = unixepoch() * 1000
WHERE paused_at IS NULL AND role = 'member' AND org_id = 'f2ab805b-1a7b-4459-b6fa-48556c4b5888'
  AND user_id IN (SELECT user_id FROM managed_subscriptions);

-- No such space is made again, by the release still serving while this is applied or by anything later: the column
-- stays (a column with a foreign key can't be dropped in place) and nothing may fill it.
CREATE TRIGGER organizations_no_managed_space_insert
BEFORE INSERT ON organizations
WHEN NEW.managed_host_org_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'CloudChef runs no spaces');
END;

CREATE TRIGGER organizations_no_managed_space_update
BEFORE UPDATE OF managed_host_org_id ON organizations
WHEN NEW.managed_host_org_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'CloudChef runs no spaces');
END;

-- What was kept about subscriptions, building credit, domains and the waitlist is emptied: nothing reads it any
-- more, so it would be held for no purpose and missing from a person's export. Stripe keeps its own record of
-- payments. The tables and columns themselves go in a later migration, once the release that named them is gone.
DELETE FROM space_domains;
DELETE FROM space_credit_purchases;
DELETE FROM space_month_allowances;
DELETE FROM managed_subscriptions;
DELETE FROM stripe_events;
UPDATE "user" SET managed_space_waitlist_at = NULL WHERE managed_space_waitlist_at IS NOT NULL;
UPDATE organization_usage_daily SET container_seconds = 0 WHERE container_seconds <> 0;
