-- Every place a person builds is a space: an organization with the people in it and a connection to the Cloudflare
-- account it builds in, its own or (0070) the one CloudChef runs. A person's own Cloudflare account, until now a
-- connection that was theirs alone, becomes a space with one person in it, so they invite people into it as into
-- any other. `personal_user_id` names the person a space was made for: the one a Cloudflare sign-in that names no
-- space connects, whose workspace there keeps the name and secret it always had, and who stays its admin.
ALTER TABLE organizations ADD COLUMN personal_user_id TEXT;

CREATE UNIQUE INDEX idx_organizations_personal_user
ON organizations(personal_user_id) WHERE personal_user_id IS NOT NULL;

-- Each person's own connection gets a space of the same id, named for them, with them as its admin.
INSERT INTO organizations (id, name, created_by, created_at, updated_at, personal_user_id)
SELECT
  connections.id,
  CASE
    WHEN trim(people.name) = '' THEN 'My space'
    ELSE substr(trim(people.name), 1, instr(trim(people.name) || ' ', ' ') - 1) || '’s space'
  END,
  connections.user_id,
  connections.created_at,
  connections.updated_at,
  connections.user_id
FROM cloudflare_connections AS connections
JOIN "user" AS people ON people.id = connections.user_id
WHERE connections.user_id IS NOT NULL;

INSERT INTO organization_members (org_id, user_id, role, joined_at, drafts_allowed)
SELECT connections.id, connections.user_id, 'admin', connections.created_at, 1
FROM cloudflare_connections AS connections
WHERE connections.user_id IS NOT NULL;

-- Their projects become the space's, which they run as its admin.
UPDATE org_projects SET org_id = connection_id
WHERE org_id IS NULL
  AND connection_id IN (SELECT id FROM cloudflare_connections WHERE user_id IS NOT NULL);

-- The connection keeps its id, which sessions, workspaces, projects and GitHub installations are keyed by, and
-- becomes the space's.
UPDATE cloudflare_connections SET org_id = id, user_id = NULL
WHERE user_id IS NOT NULL;

-- While the release before this one still serves, it writes a person's own connection and their projects the old
-- way: each such write is made the space's as it lands, so nothing is ever read in the old shape. A second
-- connection for someone who has a space already fails on the index above, which that release reports as a
-- connection that changed meanwhile. Dropped by a later migration, once nothing writes this way.
CREATE TRIGGER cloudflare_connections_personal_space_during_rollout
AFTER INSERT ON cloudflare_connections
WHEN NEW.user_id IS NOT NULL
BEGIN
  INSERT INTO organizations (id, name, created_by, created_at, updated_at, personal_user_id)
  SELECT
    NEW.id,
    CASE
      WHEN trim(people.name) = '' THEN 'My space'
      ELSE substr(trim(people.name), 1, instr(trim(people.name) || ' ', ' ') - 1) || '’s space'
    END,
    NEW.user_id,
    NEW.created_at,
    NEW.updated_at,
    NEW.user_id
  FROM "user" AS people WHERE people.id = NEW.user_id;
  INSERT INTO organization_members (org_id, user_id, role, joined_at, drafts_allowed)
  VALUES (NEW.id, NEW.user_id, 'admin', NEW.created_at, 1);
  UPDATE cloudflare_connections SET org_id = NEW.id, user_id = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER org_projects_space_during_rollout
AFTER INSERT ON org_projects
WHEN NEW.org_id IS NULL
BEGIN
  UPDATE org_projects
  SET org_id = (SELECT org_id FROM cloudflare_connections WHERE id = NEW.connection_id)
  WHERE id = NEW.id;
END;
