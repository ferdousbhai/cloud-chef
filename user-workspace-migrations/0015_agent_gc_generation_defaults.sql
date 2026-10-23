-- A deleted conversation's agents are destroyed whole, so a candidate's generation range no longer means
-- anything. The runtime this ships with stops naming the two columns, which needs a default for each:
-- max_generation had none, and its CHECK names next_generation, which would keep either from being dropped
-- alone. SQLite can't change a column's default or constraint in place, so the table is rebuilt with every
-- row; a later migration drops both columns once no serving runtime names them.
CREATE TABLE agent_gc_candidates_next (
  chat_id TEXT NOT NULL,
  initial_id TEXT NOT NULL,
  subchat_index INTEGER NOT NULL CHECK (subchat_index >= 0),
  next_generation INTEGER NOT NULL DEFAULT 0,
  max_generation INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (chat_id, subchat_index)
);

INSERT INTO agent_gc_candidates_next (
  chat_id, initial_id, subchat_index, next_generation, max_generation, not_before, created_at, attempts
)
SELECT chat_id, initial_id, subchat_index, next_generation, max_generation, not_before, created_at, attempts
FROM agent_gc_candidates;

DROP INDEX idx_agent_gc_due;
DROP TABLE agent_gc_candidates;
ALTER TABLE agent_gc_candidates_next RENAME TO agent_gc_candidates;

CREATE INDEX idx_agent_gc_due
ON agent_gc_candidates(not_before, chat_id, subchat_index);
