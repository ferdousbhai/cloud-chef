-- Signing in the command line from a browser: the command line asks for a sign-in, the person approves its short
-- code in CloudChef while signed in, and the command line then takes its new token. Only hashes of the codes are
-- kept, and each sign-in lasts ten minutes.
CREATE TABLE command_line_logins (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
