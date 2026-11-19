-- A private project's post stays, seen only by the people who may view the project (docs/proposals/comment-threads.md):
-- posts hidden only because their project went private show again to them. They stay off pages, Explore and feeds,
-- which show only public projects' posts, and their media was deleted when the project went private.
UPDATE posts SET status = 'visible', hidden_reason = NULL WHERE status = 'hidden' AND hidden_reason = 'project_private';
