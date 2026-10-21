-- The model a Cloudflare account's builders start on, chosen by its admin (a team's admins, or the
-- person whose own account it is). Anyone building there can still switch; NULL means CloudChef's
-- default. Kept on the connection, the account CloudChef builds in, and read by its workspace runtimes.
ALTER TABLE cloudflare_connections ADD COLUMN default_builder_model TEXT;
