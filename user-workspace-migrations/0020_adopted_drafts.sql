-- The team project a CloudChef app's repository became when an admin approved it as a draft. From then on the app's
-- workspace is kept to read: its repository is the project's, changed only through the project, with its roles.
ALTER TABLE workspaces ADD COLUMN adopted_by_org_project_id TEXT;
