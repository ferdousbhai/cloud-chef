-- Whether an invited member may build new apps of their own (drafts) on joining, chosen by the inviting
-- admin. New invites allow it unless the admin unticks it; invites already waiting keep what they were
-- sent with, when members joined with GitHub projects only.
ALTER TABLE organization_invites ADD COLUMN drafts_allowed INTEGER NOT NULL DEFAULT 1
  CHECK (drafts_allowed IN (0, 1));
UPDATE organization_invites SET drafts_allowed = 0 WHERE accepted_at IS NULL;
