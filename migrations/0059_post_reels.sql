-- A post's clip ("stills with motion", app/lib/reel.ts): real screenshots of the live site the builder agent took in
-- the person's workspace, a timeline that shows them one after another, and spoken lines, posted only after the
-- person approved it in the chat. Each file is a post_media row and an R2 object: the timeline (kind 'reel', JSON),
-- its pictures ('reel_still') and its spoken lines ('reel_audio'), the last two naming their timeline in `part_of`.
-- Replacing or deleting the timeline deletes its parts by cascade, and post_media_deleted removes each object.
ALTER TABLE post_media ADD COLUMN part_of TEXT REFERENCES post_media(id) ON DELETE CASCADE;
-- A part's place in its timeline: the picture at 0 is the clip's first, shown before it plays.
ALTER TABLE post_media ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_post_media_part_of ON post_media(part_of);
