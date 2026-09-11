-- Nothing records or reads what provisioning creates any more. Workspace resource names are
-- derived from sha256(accountId:userId), so a Worker, database, or container belonging to a user
-- is nameable from the user and the account alone and no longer needs a row to be findable. The
-- writer and the reclamation path this table anchored were both removed with that change.
DROP INDEX idx_user_workspace_runtime_resources_outstanding;

DROP TABLE user_workspace_runtime_resources;
