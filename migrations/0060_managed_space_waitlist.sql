-- When a person joined the waitlist for a space CloudChef runs (managed spaces), or NULL. They join from "Where should
-- your apps live?" and may leave again; when managed spaces open, the people waiting are told first.
ALTER TABLE "user" ADD COLUMN managed_space_waitlist_at INTEGER;
