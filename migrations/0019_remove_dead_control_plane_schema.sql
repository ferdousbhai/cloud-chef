-- Commit 0619ac5 "Simplify Cloudflare-native workspace lifecycle" removed the last reader and the
-- last writer of all of this. No scheduled handler claims a daily-maintenance slot any more, the
-- account-anchored reconcile sweep it recorded receipts for is gone, and the ops report reads only
-- users, connections, auth sessions and runtime locators. The three runtime columns anchored the
-- provisioning lease and upgrade-deferral bookkeeping that moved into Cloudflare Workflows; the
-- repository selects explicit columns, so nothing observes them.
DROP INDEX idx_app_resource_reconcile_runs_started;

DROP TABLE app_resource_reconcile_runs;

DROP TABLE daily_maintenance_jobs;

ALTER TABLE user_computer_runtimes DROP COLUMN provisioning_attempt_id;

ALTER TABLE user_computer_runtimes DROP COLUMN provisioning_lease_expires_at;

ALTER TABLE user_computer_runtimes DROP COLUMN upgrade_deferred_since;
