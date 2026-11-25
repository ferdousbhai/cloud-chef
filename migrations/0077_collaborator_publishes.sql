-- A publish that runs for someone who neither made the project nor is an admin of its space is a collaborator's: it
-- may use what the project's Worker already uses in the account, and add nothing. The control plane decides that when
-- the commit is claimed or tried again, keeps it here, and gives the account's authorization for such a publish only
-- to a workspace runtime that says it holds the publish to that.
ALTER TABLE project_deployments ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1));
