-- The GitHub projects an invite gives its person: a JSON array of org_projects ids the inviting admin
-- chose. Accepting grants access to those that still exist in the organization; NULL gives none.
ALTER TABLE organization_invites ADD COLUMN project_ids TEXT;
