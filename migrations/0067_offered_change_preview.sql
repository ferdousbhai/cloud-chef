-- An offered change's preview address, for a project Workers Builds deploys: found when someone who can edit the
-- project looks at the offer, and kept so the thread links it (a project CloudChef deploys itself has it in
-- project_deployments).
ALTER TABLE post_comments ADD COLUMN suggested_preview_url TEXT;
