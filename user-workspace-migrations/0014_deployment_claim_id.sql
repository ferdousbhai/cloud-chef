-- The claim that moved a deployment to provisioning: a random id it writes and reads back, so a claim whose
-- acknowledgement was lost knows the committed claim for its own, and another claim made in the same
-- millisecond doesn't. A record claimed before this column existed has none, which no claim reads as its own.
ALTER TABLE deployments ADD COLUMN claim_id TEXT;
