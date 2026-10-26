-- Whether a project's live site lets CloudChef show it in a frame on the projects home: 1 it does, 0 it
-- refuses (X-Frame-Options, or a CSP frame-ancestors that leaves CloudChef out), NULL not checked yet.
-- A site that refuses is shown by its address instead of a blank frame.
ALTER TABLE org_projects ADD COLUMN site_frameable INTEGER;
