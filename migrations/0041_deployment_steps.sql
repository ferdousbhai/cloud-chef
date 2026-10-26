-- The step a running build and deploy of a project CloudChef deploys is on, and since when, so its card can say
-- what is happening rather than only that something is.
ALTER TABLE project_deployments ADD COLUMN step TEXT
  CHECK (step IN ('preparing', 'installing', 'building', 'migrating', 'publishing'));
ALTER TABLE project_deployments ADD COLUMN step_started_at INTEGER;
