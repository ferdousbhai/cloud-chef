-- What nothing reads any more: the GitHub approval states of production requests (drafts are approved into their
-- own Artifacts repository now), and the file snapshots and claim time requests kept before that.
DROP TABLE github_approval_states;
ALTER TABLE production_requests DROP COLUMN snapshot_gzip_base64;
ALTER TABLE production_requests DROP COLUMN snapshot_files;
ALTER TABLE production_requests DROP COLUMN claimed_at;
