-- Someone a project is shared with works on it in the project's own Cloudflare account, as anyone added to it does:
-- there is one way to be on someone else's project. Until now a share outside the project's space was kept in
-- project_shares, and that person worked on the project from an account of their own.
--
-- Each of those people gets on each project the role its share gave, and joins the project's space as someone who
-- works only on the projects they are given. A share with someone already in the space never counted (the space's own
-- grant decided their role), so it gives nothing here either: the roles are written first, while the space's people
-- are still only those it had. project_shares keeps its rows, which nothing reads from this release on; a later
-- migration drops it.
INSERT INTO org_project_access (project_id, user_id, role, granted_by, granted_at)
SELECT shares.project_id, shares.user_id, shares.role, shares.shared_by, shares.shared_at
FROM project_shares AS shares
JOIN org_projects AS projects ON projects.id = shares.project_id
WHERE projects.org_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM organization_members AS members
    WHERE members.org_id = projects.org_id AND members.user_id = shares.user_id
  )
ON CONFLICT (project_id, user_id) DO NOTHING;

INSERT INTO organization_members (org_id, user_id, role, joined_at, drafts_allowed)
SELECT projects.org_id, shares.user_id, 'member', MIN(shares.shared_at), 0
FROM project_shares AS shares
JOIN org_projects AS projects ON projects.id = shares.project_id
WHERE projects.org_id IS NOT NULL
GROUP BY projects.org_id, shares.user_id
ON CONFLICT (org_id, user_id) DO NOTHING;
