-- Invites into a space and the counts that limited them and the spaces a person made, named by nothing since the
-- release that shipped 0079: someone comes into a space by a project shared with them (project_invitations), and no
-- space is made beside a person's own. organization_members.drafts_allowed stays, unread: 0074's rollout trigger
-- still writes it.
DROP TABLE organization_invites;
DROP TABLE organization_quota_events;
