-- Invite emails sent and teams created, counted toward their limits (per team and per sender a day,
-- per creator a month). The log is apart from the invites and teams themselves, so revoking an invite
-- or deleting a team doesn't take back what it counted: the team is named by id, without a foreign key.
-- Each entry goes with the person who made it, and is pruned once it is older than any limit's window.
CREATE TABLE organization_quota_events (
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'team')),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_organization_quota_events_user
ON organization_quota_events(user_id, kind, created_at);
CREATE INDEX idx_organization_quota_events_org
ON organization_quota_events(org_id, kind, created_at);
CREATE INDEX idx_organization_quota_events_created
ON organization_quota_events(created_at);

-- What has already been sent counts from today, so the limits hold across this deploy.
INSERT INTO organization_quota_events (kind, user_id, org_id, created_at)
SELECT 'invite', invites.invited_by, invites.org_id, invites.created_at
FROM organization_invites AS invites
JOIN "user" ON "user".id = invites.invited_by;
INSERT INTO organization_quota_events (kind, user_id, org_id, created_at)
SELECT 'team', organizations.created_by, organizations.id, organizations.created_at
FROM organizations
JOIN "user" ON "user".id = organizations.created_by;

-- A decided production request keeps only its title, how many files it had, and the decision: the
-- member's note and preview link went with the draft's files.
UPDATE production_requests SET note = NULL, preview_url = NULL WHERE status IN ('approved', 'declined');
