-- How long each member's workspace container ran in their organization's account, a day at a time, beside the
-- tokens of their builder turns: a space CloudChef runs is held to a monthly allowance that counts both.
ALTER TABLE organization_usage_daily ADD COLUMN container_seconds INTEGER NOT NULL DEFAULT 0;
