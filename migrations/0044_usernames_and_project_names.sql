-- Addresses like GitHub's: every person has a username, and every project a name in addresses (`slug`) that is
-- unique among its author's projects, so a project is `<username>/<slug>` (cloudchef.build/<username>/<slug>.git).
-- Usernames are lowercase letters, digits and dashes, chosen at sign-up; the two people already here are set.
ALTER TABLE "user" ADD COLUMN username TEXT;
CREATE UNIQUE INDEX user_username ON "user"(username) WHERE username IS NOT NULL;
UPDATE "user" SET username = 'ferdous' WHERE email = 'ferdousbd@gmail.com';
UPDATE "user" SET username = 'sara' WHERE email = 'saraadolfsen@gmail.com';

ALTER TABLE org_projects ADD COLUMN slug TEXT;
-- From the name as people see it: lowercase, spaces and the usual punctuation as dashes. The app makes new ones the
-- same way and adds -2, -3… when the author already has that name.
UPDATE org_projects SET slug = trim(
  replace(replace(replace(replace(replace(replace(replace(lower(name), ' ', '-'), '''', '-'), '_', '-'), '.', '-'),
    '/', '-'), '(', ''), ')', ''),
  '-'
)
WHERE slug IS NULL;
UPDATE org_projects SET slug = slug || '-' || substr(id, 1, 4)
WHERE slug IS NOT NULL AND rowid NOT IN (SELECT min(rowid) FROM org_projects GROUP BY created_by, slug);
CREATE UNIQUE INDEX org_projects_author_slug ON org_projects(created_by, slug);
