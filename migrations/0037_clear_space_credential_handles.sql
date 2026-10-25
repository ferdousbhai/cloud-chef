-- Each space's own credential column, which only the release before 0035 wrote, still names the credential that
-- space was connected with. Nothing reads it any more: a space's credential is its account's authorization
-- (cloudflare_authorizations). But its foreign key keeps those credentials from ever being deleted, so a
-- replaced one would stay stored for good. Emptying it lets each go once no authorization names it. 0035's
-- update trigger skips an emptied column, so no authorization changes. The release after drops the column.
UPDATE cloudflare_connections SET credential_handle = NULL WHERE credential_handle IS NOT NULL;
