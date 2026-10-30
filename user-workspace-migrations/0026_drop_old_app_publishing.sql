-- The runtime's own record of publishing a chat's app (its deployments, their resources and progress, and the cleanup
-- of a deleted app's resources) and which team project a chat's app became, unnamed since the release before, when
-- every project came to publish one way: by pushing to its repository. The tables that refer to deployments go first.
DROP TABLE deployment_activity;
DROP TABLE deployment_resources;
DROP TABLE deployments;
DROP TABLE app_resource_gc_candidates;
ALTER TABLE workspaces DROP COLUMN adopted_by_org_project_id;
