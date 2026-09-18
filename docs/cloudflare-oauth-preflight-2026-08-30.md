# Cloudflare OAuth Phase 0 preflight — dashboard capture

Date: 2026-08-30
Method: read-only inspection of the Cloudflare dashboard (Manage account → OAuth clients)
by the account operator's browser session. Nothing was changed or saved; the edit wizard
was abandoned without touching "Save changes".

## CloudChef OAuth client (verified live configuration)

- Client ID: `b18c394ddf1a34600f65da6f1e475873`
- Name: CloudChef — Public, Verified (DNS TXT `cloudflare_oauth_client_publisher=…` present)
- Response type: Code
- Grant types: Authorization Code, Refresh Token
- Token endpoint auth: Client Secret Basic
- Redirect (callback) URL: `https://cloudchef.build/connect/return` (exactly one)
- Client URL: `https://cloudchef.build`

## Configured scopes (9)

Matches `CORE_CLOUDFLARE_OAUTH_SCOPES` in
`app/lib/.server/cloudflare/cloudflare-oauth-scope-manifest.ts`, plus `offline_access`,
which is configured on the client itself (listed under "Other" in the scopes view), not
only appended at authorize time:

- Developer Platform: D1 Write (`d1.write`), Workers Containers Write (`containers.write`),
  Workers KV Storage Write (`workers-kv-storage.write`), Workers R2 Storage Write
  (`workers-r2.write`), Workers Scripts Write (`workers-scripts.write`)
- AI & Machine Learning: Workers AI Read (`ai.read`)
- Account & Billing: Account Settings Read (`account-settings.read`), User Details Read
  (`user-details.read`)
- Other: `offline_access`

## Optional-scope state (decisive for the orchestrator fallback)

The "Choose optional scopes" step reads: **"All 8 permissions are required."** No configured
scope is optional. This proves the invariant `resolveGrantedScopes` relies on when Cloudflare
reports no granted-scope string: a completed exchange carries exactly the requested set,
because the user cannot decline any of it and still complete authorization. The moment any
scope is marked optional, that fallback must fail instead (the code already does).

The step offers "Mark all as optional" and per-scope Required toggles, confirming the
optional-scope mechanism from Cloudflare's 2026-08-20 GA is available to this client.

## Scope catalog shape (from the "Select permission scopes" step)

The selectable catalog is far larger than the configured set. Categories and current
selection counts: Developer Platform 5/30 · AI & Machine Learning 1/8 · DNS & Zones ·
App Security · Rules & Configuration · Cloudflare One / Zero Trust · Analytics & Logs ·
Network Services · Media · Email & Messaging · Cache & Performance · Account & Billing 2/9 ·
Other. Permission groups expose access levels named Edit / Read, with some offering
Run, Admin, Bind, Revoke, Purge, Send, Report, Evaluate, or Integration. Notable for the
plan's later phases:

- Registrar: "Registrar Domains — Admin, Read" and "Registrar Sandbox Domains — Admin, Read"
  (under DNS & Zones); registration authority is an Admin-level permission.
- Zero Trust / Access, Magic WAN/Transit, Email, Media, Zone and Billing categories all
  exist as expected for the broad profile.
- Rough scale: ~200 permission groups across ~13 categories, i.e. several hundred scope IDs.

## Scope catalog fetched (same day, authorized cloudflare-api MCP)

With the operator's explicit approval, the official Cloudflare API MCP server was authorized
(its own OAuth flow, consent screen observed live) and `GET /oauth/scopes` was fetched through
it - no token ever reached this repository or the session transcript.

- Catalog: **383 scope IDs**, checked in verbatim as
  `docs/cloudflare-oauth-scope-catalog-2026-08-30.tsv` (id, category, display name; sorted).
- SHA-256 of the checked-in TSV: `63843689e99c1ac765e8ecc28c7054f1d7a4aa47a3dae8f01dae7370bcad2ee5`.
- All 8 core manifest IDs are present verbatim. `offline_access` is not in the catalog - it is
  an OAuth protocol scope, not a permission, confirming the manifest's treatment.
- Registrar registration authority is `registrar-domains.admin` (plus `.read`, and sandbox
  variants) - an Admin access level, matching the plan's approval-gating for purchases.
- Access levels observed beyond read/write: admin, bind, edit, evaluate, index, metadata_read,
  monitoring, purge, report, revoke, run, send, shield, location - the broad-profile generator
  must not assume a read/write dichotomy.

The MCP server's own consent screen (a live example of a broad-grant consent) showed 194
requested permissions across 13 categories with a REQUIRED section (User Read, Background
Access) and an ADDITIONAL ACCESS section with per-category expansion and an Edit Permissions
control - the consent UX the plan's Phase 3 copy must anticipate.

## Still unverified (needs a staging consent run with the CloudChef client)

1. Whether CloudChef's token response or callback carries the granted `scope` string once
   optional scopes exist, and its exact contents in Full access / Read only / custom-partial
   consent modes.
2. Authorize-URL size with the full catalog requested.
3. A CloudChef-issued access token as direct bearer auth against
   `https://mcp.cloudflare.com/mcp` (the Claude Code MCP client authenticated successfully with
   the server's own client, which proves the endpoint and flow but not CloudChef's token).
4. Refresh behaviour and `insufficient_scope` reporting for partial grants.

## Staging consent runs (2026-08-31, ephemeral PKCE client, now deleted)

Created a throwaway public PKCE-only OAuth client (token auth method "None", so no secret was ever
issued), configured with the two identity-read scopes required and workers-scripts.read as a single
optional scope. Ran the authorization-code + PKCE flow three times against a localhost callback
listener, then revoked every grant and deleted the client. Findings:

1. **The provider reports granted scopes, distinct from requested.** Both the callback query and the
   token response carry a `scope` field. Run 3 (fresh grant, optional scope declined via the consent
   screen's per-category toggle) returned `scope=account-settings.read user-details.read` with
   `workers-scripts.read` ABSENT - the declined optional scope is not in the granted set. The
   dashboard confirmed it: that grant showed "2 permissions" versus 3 for the full grants.
   → The orchestrator's primary path (parse the reported `scope`; never equate requested with
   granted) is correct and becomes load-bearing the moment the broad optional profile is non-empty.

2. **A re-authorization while a prior grant is active returns the union with previously-granted
   scopes.** Run 2 declined the optional scope but the token still came back with all three, because
   run 1's grant was still active; only after revoking (run 3) did the decline take effect. →
   Narrowing a grant requires revoking the old one (or the plan's reauthorization path bumping
   connection_generation to force a fresh consent), not merely re-running authorize. The existing
   generation mechanism already does this.

3. **offline_access must be a configured scope on the client**, not just appended at authorize time:
   requesting it on a client not configured for it returned `error=invalid_scope ... not allowed to
request scope 'offline_access'`. The production client already lists it (part 1), so the
   scope-manifest ↔ OAuth-client sync must keep offline_access in the client's allowed scopes.

4. **token_type is `bearer`, access-token lifetime ~3599s.** The PKCE public client without
   offline_access granted returned no refresh_token; the production confidential client does (part 1
   requires it). Nothing contradicts the manifest.

Every Phase 0 open item from the 2026-08-30 report is now closed except one: a CloudChef-issued
token used as bearer against mcp.cloudflare.com/mcp under the real grant. The Phase 4 gateway targets
that endpoint and the MCP server's own client authenticated there fine (proving endpoint + transport),
but CloudChef's own token as bearer is currently validated only by the gateway's tests against a
mock, not yet against the live server - that verification belongs to Phase 5 integration.
