-- Which draft a production request carries, so sending the draft again replaces what the admins see
-- instead of asking twice. draft_id is the builder that holds the draft; draft_revision is the validated
-- revision sent. Requests sent before this have neither.
ALTER TABLE production_requests ADD COLUMN draft_id TEXT;
ALTER TABLE production_requests ADD COLUMN draft_revision TEXT;
-- When a member last sent a newer revision of the same draft; NULL until then.
ALTER TABLE production_requests ADD COLUMN updated_at INTEGER;

-- One open request per draft, however many tabs send it at once.
CREATE UNIQUE INDEX idx_production_requests_open_draft
ON production_requests(org_id, requested_by, draft_id)
WHERE draft_id IS NOT NULL AND status IN ('pending', 'approving');
