-- A post's clip ("stills with motion", app/lib/reel.ts): real screenshots of the live site the builder agent took in
-- the person's workspace, a timeline that shows them one after another, and spoken lines, posted only after the
-- person approved it in the chat. Each file is a post_media row and an R2 object: the timeline (kind 'reel', JSON),
-- its pictures ('reel_still') and its spoken lines ('reel_audio'), the last two naming their timeline's id in
-- `part_of`. A clip's rows go together (replaceReel and removeReel take every row of the three kinds, and a post's
-- own deletion takes all its media), and post_media_deleted removes each object.
ALTER TABLE post_media ADD COLUMN part_of TEXT;
-- A part's place in its timeline: the picture at 0 is the clip's first, shown before it plays.
ALTER TABLE post_media ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
