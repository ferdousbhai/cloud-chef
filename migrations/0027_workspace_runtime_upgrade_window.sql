-- A release no longer redeploys a workspace runtime the moment its owner next asks for a session: the
-- upgrade waits until nothing is running in it, while the browser keeps working with the runtime it has.
--
-- `protocol_version` is the browser and control-plane contract the runtime speaks. A runtime upgrade is
-- deferred only while it still speaks the current one; NULL is a runtime provisioned before it was
-- recorded, which speaks protocol 1.
ALTER TABLE user_computer_runtimes ADD COLUMN protocol_version INTEGER;

-- When a browser last received a session for the runtime. A runtime from before this release cannot say
-- whether it is busy, so it is upgraded only after no session was issued for longer than a turn can run;
-- every existing runtime counts as just used, since a turn started before this release may still run.
ALTER TABLE user_computer_runtimes ADD COLUMN last_session_at INTEGER;
UPDATE user_computer_runtimes SET last_session_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE last_session_at IS NULL;
