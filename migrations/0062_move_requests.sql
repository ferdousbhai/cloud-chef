-- A person's request to have a site they run elsewhere (a Shopify shop, a WordPress site, another hosted site) moved
-- into their own Cloudflare account with CloudChef (`/move`, `docs/proposals/move-in.md`): its address, the platform
-- it is on, and a note if they left one. One row per person and address; asking again for the same address updates it,
-- and withdrawing it deletes the row. Erasing the account deletes its requests with it.
CREATE TABLE move_requests (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  site_url TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('shopify', 'wordpress', 'other')),
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, site_url)
) WITHOUT ROWID;
