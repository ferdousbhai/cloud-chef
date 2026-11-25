-- What 0068 to 0073 added for spaces CloudChef ran in its operator's account, emptied by 0075 and named by nothing
-- since the release that shipped it. `organizations.managed_host_org_id` stays, fenced by 0075's triggers: a column
-- with a foreign key can't be dropped in place.
DROP TABLE space_domains;
DROP TABLE space_credit_purchases;
DROP TABLE space_month_allowances;
DROP TABLE managed_subscriptions;
DROP TABLE stripe_events;
ALTER TABLE "user" DROP COLUMN managed_space_waitlist_at;
ALTER TABLE organization_usage_daily DROP COLUMN container_seconds;
