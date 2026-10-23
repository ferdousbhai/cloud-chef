-- A production deployment of a CloudChef app becomes a commit on main of the project's repository: the
-- deployment records which one, once it is written (in the background, so a deployment may have none).
ALTER TABLE deployments ADD COLUMN commit_sha TEXT;
