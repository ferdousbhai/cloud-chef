-- A person has one place to build: their own Cloudflare account. Before 2026-11-25 they could make more spaces
-- beside it, and some of those were connected to the very account their own space builds in. Each such space is
-- folded into the own space of whoever made it: its projects move there (their code, sites and data are in that
-- same Cloudflare account already, so nothing moves in Cloudflare), and its people become people of that space,
-- keeping what they had on each project. The emptied space stays, with its people and their workspaces, for its
-- admin to delete, which is what removes those workspaces from the account. A space connected to another Cloudflare
-- account is left as it is.
CREATE TABLE space_merges AS
SELECT extra.id AS from_org, extra_connection.id AS from_connection, own.id AS to_org,
       own_connection.id AS to_connection
FROM organizations AS extra
JOIN cloudflare_connections AS extra_connection
  ON extra_connection.org_id = extra.id AND extra_connection.status = 'active'
JOIN organizations AS own ON own.personal_user_id = extra.created_by
JOIN cloudflare_connections AS own_connection
  ON own_connection.org_id = own.id AND own_connection.status = 'active'
 AND own_connection.account_id = extra_connection.account_id
WHERE extra.personal_user_id IS NULL
  -- Only by an admin of it: whoever made it and has since stepped down doesn't take it along.
  AND EXISTS (
    SELECT 1 FROM organization_members AS admins
    WHERE admins.org_id = extra.id AND admins.user_id = extra.created_by AND admins.role = 'admin'
  );

-- Its other admins ran every project in it: in the space it moves to they are added to each, to edit.
INSERT INTO org_project_access (project_id, user_id, role, granted_by, granted_at)
SELECT projects.id, members.user_id, 'edit', NULL, members.joined_at
FROM space_merges AS merges
JOIN org_projects AS projects ON projects.connection_id = merges.from_connection
JOIN organization_members AS members ON members.org_id = merges.from_org AND members.role = 'admin'
WHERE NOT EXISTS (
  SELECT 1 FROM organization_members AS already
  WHERE already.org_id = merges.to_org AND already.user_id = members.user_id AND already.role = 'admin'
)
ON CONFLICT (project_id, user_id) DO NOTHING;

-- Its people come along as people added to projects there; someone already in that space keeps their place.
INSERT INTO organization_members (org_id, user_id, role, joined_at, paused_at)
SELECT merges.to_org, members.user_id, 'member', MIN(members.joined_at), MAX(members.paused_at)
FROM space_merges AS merges
JOIN organization_members AS members ON members.org_id = merges.from_org
WHERE true
GROUP BY merges.to_org, members.user_id
ON CONFLICT (org_id, user_id) DO NOTHING;

-- A project stays behind only where the space it would move to already has one with the same repository, import
-- source or Worker, which its unique indexes refuse.
UPDATE org_projects
SET connection_id = (SELECT to_connection FROM space_merges WHERE from_connection = org_projects.connection_id),
    org_id = (SELECT to_org FROM space_merges WHERE from_connection = org_projects.connection_id)
WHERE connection_id IN (SELECT from_connection FROM space_merges)
  AND NOT EXISTS (
    SELECT 1 FROM org_projects AS taken
    JOIN space_merges AS merges ON merges.to_connection = taken.connection_id
    WHERE merges.from_connection = org_projects.connection_id
      AND (taken.artifact_repo = org_projects.artifact_repo
        OR taken.import_repo_id = org_projects.import_repo_id
        OR taken.import_repo_full_name = org_projects.import_repo_full_name COLLATE NOCASE
        OR taken.deploy_worker_name = org_projects.deploy_worker_name)
  );

DROP TABLE space_merges;
