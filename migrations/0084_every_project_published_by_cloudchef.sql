-- Every project is built and deployed by CloudChef's own builder, so which builder a project has is no longer a
-- fact to record, and no Worker of Workers Builds is remembered for it. Nothing has read or written either column
-- since the release before this one.
ALTER TABLE org_projects DROP COLUMN deploys_with;
ALTER TABLE org_projects DROP COLUMN workers_builds_script_tag;
