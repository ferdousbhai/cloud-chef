-- Signing in without a Cloudflare login: an emailed one-time link or Google. People who build in an
-- organization's Cloudflare account have no Cloudflare login of their own, so a CloudChef session no
-- longer implies a Cloudflare connection. Everything here is additive, so a still-serving previous
-- deployment keeps reading a coherent schema during rollout.

-- The Google account a user signed in with (OpenID `sub`), like cloudflare_subject for Cloudflare.
ALTER TABLE "user" ADD COLUMN google_subject TEXT;

CREATE UNIQUE INDEX idx_user_google_subject
ON "user"(google_subject) WHERE google_subject IS NOT NULL;

-- When CloudChef itself last proved this user holds their email: an emailed link, or Google with a
-- verified email. Null for users known only through Cloudflare, whose reported email CloudChef has
-- never checked. A Cloudflare sign-in never takes over a user with a proven email, never overwrites
-- that email, and only a proven email can accept an organization invite.
ALTER TABLE "user" ADD COLUMN email_proven_at INTEGER;

-- One-time sign-in links sent by email. Only the token's SHA-256 is kept, and a link works once,
-- before it expires. It isn't tied to the browser that asked for it: people open mail on their phone.
CREATE TABLE email_sign_in_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_email_sign_in_tokens_email_created
ON email_sign_in_tokens(email, created_at DESC);
CREATE INDEX idx_email_sign_in_tokens_expires
ON email_sign_in_tokens(expires_at);

-- A Google sign-in in progress: the PKCE verifier and where to return, keyed by the OAuth state.
CREATE TABLE google_sign_in_states (
  id TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_google_sign_in_states_expires
ON google_sign_in_states(expires_at);

-- Connecting Cloudflare while already signed in (by email or Google) attaches the connection to that
-- user, rather than to whichever user the Cloudflare identity would otherwise resolve to. No foreign
-- key: the row lives minutes, the callback reads the user again, and retention prunes it.
ALTER TABLE cloudflare_oauth_states ADD COLUMN linking_user_id TEXT;
