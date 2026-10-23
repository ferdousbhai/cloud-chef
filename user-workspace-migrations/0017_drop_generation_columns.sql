-- A transcript's agents are addressed by name and a deleted conversation's agents are destroyed whole, so the
-- transcript and cleanup-candidate generation columns mean nothing. The release before this one stopped naming
-- them, so the runtime serving while this applies never does. max_generation goes first: its CHECK named
-- next_generation until 0015, and dropping in this order holds either way.
ALTER TABLE chat_transcripts DROP COLUMN generation;
ALTER TABLE chat_transcripts DROP COLUMN parent_generation;
ALTER TABLE agent_gc_candidates DROP COLUMN max_generation;
ALTER TABLE agent_gc_candidates DROP COLUMN next_generation;
