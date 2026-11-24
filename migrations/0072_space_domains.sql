-- A domain of a person's own serving a project in a space CloudChef runs. 'connected' is one they bought
-- elsewhere and pointed at CloudChef with a CNAME (a Cloudflare custom hostname on CloudChef's zone, with a
-- Worker route to the project's Worker); 'bought' is one registered through CloudChef in the operator's
-- Cloudflare account, in the buyer's name, paid for yearly by a Stripe subscription of its own. A hostname
-- serves one project; a bought domain outlives the project it points at, which is why that is nullable.
CREATE TABLE space_domains (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES org_projects(id) ON DELETE SET NULL,
  hostname TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('connected', 'bought')),
  -- 'pending' until Cloudflare serves the hostname with a certificate, then 'active'; 'failed' when a purchase
  -- was paid for and the registration did not complete.
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'failed')),
  -- A bought domain's yearly subscription, what it charges in cents, and when the registration runs to.
  stripe_subscription_id TEXT UNIQUE,
  yearly_price_cents INTEGER,
  expires_at INTEGER,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX idx_space_domains_org ON space_domains(org_id);
CREATE INDEX idx_space_domains_project ON space_domains(project_id);
