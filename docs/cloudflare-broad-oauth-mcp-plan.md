# Broad Cloudflare OAuth and official MCP integration plan

Status: implementation plan  
Prepared: 2026-08-30  
Audience: CloudChef coding agent and reviewers

## Outcome

Change CloudChef's existing Cloudflare sign-in/sign-up authorization so that a user can grant Ghost the broadest Cloudflare API access available to that user. Reuse that same refreshable Cloudflare credential to call Cloudflare's managed API MCP server at `https://mcp.cloudflare.com/mcp`. Do not add a second MCP-specific OAuth prompt.

When the full grant is present, Ghost should be able to discover and invoke any operation that all of the following permit:

- the public Cloudflare API and official MCP server expose the operation;
- the user's OAuth grant contains the necessary scope;
- the user's Cloudflare account role, selected account/resources, plan, billing state, and product entitlements allow it; and
- CloudChef's explicit approval and safety policy allows that particular invocation.

This includes the Cloudflare Registrar API. With Registrar Write permission and Cloudflare's billing, registrant-contact, agreement, and availability prerequisites satisfied, Ghost can search for, price, and register a domain. Registration is a billable, normally irreversible action and must never execute without an operation-specific user approval.

“Anything the user can do” must not be presented as literal dashboard parity. Cloudflare has no wildcard OAuth scope, some dashboard/support/partner actions are not public API operations, and a token cannot exceed the authorizing member's effective access.

## Current state and gaps

The current implementation is intentionally narrow:

- `wrangler.jsonc` requests eight scope IDs: `account-settings.read`, `user-details.read`, Workers Scripts Write, Containers Write, D1 Write, R2 Write, KV Write, and Workers AI Read.
- `app/lib/.server/cloudflare/cloudflare-oauth-orchestrator.ts` validates that narrow set, adds `offline_access`, performs Authorization Code plus PKCE, and stores a refresh token.
- The model receives only workspace tools and `search_cloudflare_docs`; it has no general Cloudflare API or MCP tools.
- `D1CloudflareCredentialVault` already encrypts access and refresh tokens, refreshes expiring access tokens, and supports revocation. It is the correct credential authority to extend.
- `BuilderAgent` extends `AIChatAgent`, but its model loop is custom Pi orchestration. The default Agents SDK `this.mcp.getAITools()` path is not currently used.

There is also a correctness defect to fix before broad access is enabled:

- `CloudflareConnectionResult.grantedCapabilities` contains CloudChef product capability names such as `workers` and `d1`, not OAuth scope IDs.
- `completeCloudflareConnectionAction()` saves those capability names into `cloudflare_connections.granted_scopes_json`.
- Consequently, the database does not currently contain an authoritative record of what OAuth scopes Cloudflare granted.

Never infer a broad grant from the existing column. Existing rows must be treated as “scope grant unknown; reauthorization required.”

## Decisions

### One user-visible authorization flow

The existing CloudChef Cloudflare authorization remains the only Cloudflare consent event. It serves both as account sign-in/sign-up and authorization for Ghost's Cloudflare tools. The MCP client authenticates with a fresh bearer access token derived from that grant.

Do not redirect the user through the official MCP server's independent OAuth flow. That would create a second grant with a separate lifecycle and would make it possible for CloudChef identity, deployment, and MCP access to refer to different accounts.

### Broad by default, user-controlled at Cloudflare

Use two scope classes:

1. **Required core scopes** are the minimum needed for identity, exactly-one-account discovery, refresh tokens, current workspace provisioning/deployment, and Workers AI inference. A user who declines a required core scope cannot complete CloudChef onboarding.
2. **Broad optional scopes** are every other production OAuth scope supported by the CloudChef OAuth client and relevant to the official Cloudflare API MCP server, including read, write, revoke, run, purge, billing, Registrar, account, user, zone, security, Zero Trust, network, media, email, and developer-platform permissions.

Cloudflare's consent screen selects requested optional permissions by default and lets the user choose Read only, Full access, categories, or individual permissions. CloudChef should explain that leaving **Full access** selected enables the complete agent capability. If the user deliberately narrows the grant, onboarding may continue only when core scopes remain, and Ghost must accurately report partial access.

Do not make hundreds of product scopes “required” merely to force broad consent. Required scopes cannot be declined, which turns a recoverable partial grant into a sign-up failure and is inconsistent with Cloudflare's optional-permission UX. The default request is still the full catalog.

### Live catalog for discovery; reviewed manifest for production

Cloudflare's authenticated `GET /oauth/scopes` endpoint is the source of truth for OAuth client scope IDs. The catalog changes over time. Do not hand-compose a large scope string from memory and do not copy the MCP repository's generated catalog without reconciliation.

Add a checked-in, generated-and-reviewed scope manifest containing at least:

- scope ID, display name, category, and read/write/revoke/run classification;
- whether CloudChef considers it required core or broad optional;
- the catalog retrieval date and a deterministic catalog digest;
- the OAuth client configuration version that was verified against it; and
- explicit inclusion of Registrar Write and other high-impact permissions.

Production must use the checked-in manifest, not fetch an unaudited scope catalog during login. Add a read-only sync/check command that fetches `GET /oauth/scopes` with an operator credential, produces a deterministic diff, redacts the credential, and fails CI when required scopes disappear or the checked-in manifest drifts. Updating the manifest remains a reviewed code change.

The current official MCP repository says its consent catalog is derived from the production `GET /oauth/scopes` response and does not impose an application-level scope-count cap. Phase 0 must nevertheless verify the real CloudChef public OAuth client accepts the complete current catalog and that the authorization URL/token exchange work at its actual size. Provider behavior wins over repository assumptions.

### Existing credential as transient MCP bearer

Use the existing encrypted refreshable credential. A Builder invocation obtains a short-lived access token through the authenticated runtime-credential boundary, sends it as `Authorization: Bearer ...` to `https://mcp.cloudflare.com/mcp`, and discards it after the request/client closes.

Do not put a user's access token in:

- BuilderAgent state, Durable Object SQL, user-workspace D1, chat messages, tool results, logs, analytics, exceptions, or browser storage;
- a generated application's files or bindings; or
- persisted Agents SDK MCP `server_options`.

The installed Agents SDK persists HTTP transport headers supplied to `addMcpServer()`. Therefore, do not call `addMcpServer()` with a refreshable user bearer token in the first implementation. Build a small transient MCP client/gateway that resolves a fresh token per operation and uses the official Streamable HTTP transport. If a later Agents SDK version supports a non-persisted asynchronous header provider, it can replace the gateway after a security review.

### Account and resource binding

The selected Cloudflare account is an authorization invariant, not model input:

- preserve the existing “exactly one authorized account” check;
- server-side code supplies the connection's `accountId` to MCP calls;
- reject any model-provided `account_id` that differs from the connection;
- do not let the model choose a second account discovered with a user-level endpoint; and
- bind pending approvals to user ID, connection ID, connection generation, account ID, and transcript identity.

Zone and resource access remains limited by the resources selected in Cloudflare consent and by the user's Cloudflare role. An `insufficient_scope` or forbidden response is a capability result, not a reason to try another account.

### Broad authorization does not mean silent mutation

Authentication answers what Ghost is technically allowed to request. Approval policy answers what it may execute without a fresh human decision. Keep these independent.

For the first mutation-capable release:

- `docs` and `search` are automatic because they do not call the user's Cloudflare API.
- Every `execute` call is approval-gated. The official server's `execute` input is generated JavaScript and may contain one or many API requests; an outer tool name alone cannot prove it is read-only.
- The approval UI displays a human-readable operation summary, HTTP methods and normalized paths, target account/zone/resource, material request fields, expected side effects, cost/irreversibility warnings, and an exact code digest.
- Approval authorizes the exact stored code and normalized inputs once. Any change in code, input, account, scope grant, connection generation, or transcript requires a new approval.
- Rejection returns a normal denied tool result and lets the model continue without retrying the same action.
- Approval expires. An expired action is rejected and must be proposed again.

After the all-execute approval path is stable, an optional second release may automatically run an `execute` call only when a real parser proves that every API call is a literal `GET` or `HEAD`, paths and methods are not dynamically constructed in a way that can hide a mutation, and no GraphQL mutation or sensitive credential endpoint is involved. Unparseable or ambiguous code remains approval-gated. Do not use regex alone to authorize execution.

Always require explicit approval for:

- `POST`, `PUT`, `PATCH`, `DELETE`, revoke, purge, rotate, deploy, or write operations;
- GraphQL requests unless the parsed document is proven query-only;
- billing, subscriptions, domain registration/transfer/renewal, or any other purchase;
- API token, service token, tunnel token, certificate/private-key, identity-provider, access-policy, member, role, or account-security changes;
- destructive, bulk, cross-zone, or externally visible actions; and
- code whose effects cannot be classified with high confidence.

### Preserve specialized build and deployment paths

Do not replace `builder-deployment-command.ts` or the exact-revision user-owned deployment executor with generic MCP calls. Those paths have stronger revision guarantees. The prompt/tool policy should direct normal generated-application deployments through the existing specialized command. MCP is for Cloudflare control-plane operations not already covered, and later consolidation requires a separate design review.

## Target request flow

```text
User chooses “Continue with Cloudflare”
  -> CloudChef requests core + complete broad optional scope manifest + offline access
  -> Cloudflare account/resource selection and consent (Full access selected by default)
  -> CloudChef exchanges code, records actual granted scope IDs, and encrypts refresh token
  -> existing/new user session starts

User asks Ghost to inspect or change Cloudflare
  -> Builder exposes official MCP docs/search/execute tools
  -> transient MCP gateway resolves a fresh access token from CloudChef's vault
  -> gateway calls https://mcp.cloudflare.com/mcp with bearer auth
  -> docs/search runs immediately
  -> execute pauses for durable approval (initial release)
  -> approved exact invocation runs once and returns a bounded, redacted result
  -> audit metadata records the decision and outcome without credentials or raw secrets
```

## Implementation phases

### Phase 0: Provider and protocol preflight

Complete this before changing production OAuth configuration.

1. Fetch the production scope catalog from `GET /oauth/scopes` using a non-production operator credential. Record only scope metadata, never the token.
2. Compare it with the official MCP server's current supported catalog and the permissions required by representative OpenAPI endpoints.
3. Confirm the current CloudChef OAuth client can be configured with the entire catalog, with core scopes required and all other scopes optional.
4. Confirm the authorize endpoint accepts the resulting scope request without URL-size or provider limits.
5. Complete a staging consent in each mode: default Full access, Read only, and a custom partial selection.
6. Establish the authoritative source for actual granted scope IDs. Prefer the token response's `scope` field if Cloudflare returns it. Also inspect documented callback/grant metadata. Never equate requested scopes with granted optional scopes.
7. Confirm a CloudChef-issued Cloudflare OAuth access token works as direct bearer authentication to `https://mcp.cloudflare.com/mcp`; list tools and perform a harmless account read.
8. Confirm the MCP endpoint's current protocol version, stateless Streamable HTTP behavior, tool names, input schemas, response limits, and error shape.
9. Confirm refresh retains the same grant and determine how `insufficient_scope`, revocation, and expired access tokens are reported.
10. Confirm Registrar Search/Availability works with a staging account or a non-purchasing request. Do not register a domain in automated tests.

Block implementation if Cloudflare exposes no authoritative way to determine optional scopes actually granted. The fallback design is to make the chosen production scope profile required and document the consent tradeoff; do not silently assume optional scopes were granted.

Phase 0 deliverables:

- `app/lib/.server/cloudflare/cloudflare-oauth-scope-manifest.generated.ts` (or a JSON equivalent with a typed reader);
- a deterministic manifest generation/check script under `scripts/`;
- a short checked-in preflight report with date, catalog digest, MCP tool schemas, and provider constraints; and
- fixtures for OAuth Full, Read-only, and partial token responses with all credentials removed.

### Phase 1: Correct the OAuth data model

Add a new control-plane migration after `migrations/0015_workspace_runtime_image_digest.sql`. Preserve existing data and do not reinterpret legacy values as OAuth scopes.

Recommended connection fields:

| Field                         | Purpose                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `granted_capabilities_json`   | CloudChef product capabilities such as Workers, D1, and R2. Backfill from the legacy `granted_scopes_json`. |
| `requested_oauth_scopes_json` | Exact scope IDs in the authorization request.                                                               |
| `granted_oauth_scopes_json`   | Exact provider-confirmed scope IDs.                                                                         |
| `oauth_scope_profile_version` | Manifest/catalog version used for the grant.                                                                |
| `oauth_scope_grant_status`    | `unknown`, `core`, `partial`, or `full`.                                                                    |
| `oauth_grant_updated_at`      | When Cloudflare issued or replaced the grant.                                                               |

Update `CloudflareConnection` to expose `grantedCapabilities` and `grantedOAuthScopes` as different typed properties. Retire the ambiguous `grantedScopes` name throughout the application.

Backfill rules:

- copy legacy product capability arrays into `granted_capabilities_json` after schema validation;
- set existing `granted_oauth_scopes_json` to an empty array and grant status to `unknown`;
- require reauthorization before enabling broad MCP for those rows; and
- keep existing build/deployment behavior working while reauthorization is pending.

Update optimistic race/equivalence checks in `cloudflare-integration.ts` to compare account, credential generation, actual OAuth scopes, product capabilities, profile version, and billing capability independently.

### Phase 2: Broaden and verify the existing OAuth flow

Update the OAuth orchestrator and schemas:

1. Replace the single hand-written scope string contract with the versioned manifest.
2. Retain a small semantic core-scope assertion. Resolve exact current IDs during Phase 0 because Cloudflare's catalogs and aliases evolve.
3. Request a stable, deduplicated ordering of core scopes, broad optional scopes, and `offline_access`.
4. Parse and validate provider-reported granted scopes during code exchange. Reject unknown scope IDs, duplicates after normalization, missing core scopes, or a grant belonging to an unexpected account.
5. Save requested and actually granted scopes separately.
6. Calculate grant state:
   - `full`: every current broad profile scope is granted;
   - `partial`: core is present but one or more broad scopes are absent;
   - `core`: only the minimum feature set is available; and
   - `unknown`: legacy/unverifiable grant; MCP disabled.
7. Include the grant state and missing-scope summary in the authenticated connection/status response, but never include tokens.
8. Continue requiring a refresh token. A refresh token cannot add a new scope; scope expansion requires a new authorization-code consent.

Update the Cloudflare OAuth client itself, not only `wrangler.jsonc`:

- include Authorization Code and refresh-token/offline access as supported by Cloudflare's current client API;
- set the complete reviewed manifest as allowed scopes;
- mark only core scopes required and all broad permissions optional;
- retain exact production redirect URLs, client/policy/terms URLs, public visibility, and verified publisher domain; and
- save an exported redacted client configuration/digest for config verification.

Do not add mutations to `pnpm run ops` or `pnpm run ops:json`; those commands must stay read-only. Provide either a documented dashboard runbook or a separate explicit `--apply` administration command for changing the OAuth client. The command must show the scope diff, require the expected client/account IDs, and never print the client secret or operator token.

Update `scripts/verify-production-config.mjs` so it checks the configured scope-manifest digest and core inclusion rather than pinning the old eight-scope string. Update `wrangler.jsonc` only after the OAuth client accepts the same manifest.

### Phase 3: Reauthorization and connection UX

New sign-ups immediately use the broad request. Existing users cannot inherit new scopes through refresh and need a one-time reconnect.

Add account states and UI:

- **Full Cloudflare access**: current scope-profile digest and all profile scopes granted.
- **Partial Cloudflare access**: show grouped missing categories and a “Grant full access” reconnect action.
- **Core build access**: existing build features available, broad MCP unavailable or limited to scopes proven present.
- **Reauthorization required**: legacy/unknown grant; broad MCP disabled until reconnect.
- **Revoked/error**: current fail-closed recovery behavior.

The onboarding and settings copy must plainly say that Full access lets Ghost read and change Cloudflare resources, manage security and identity settings, create credentials, and perform billable actions only after an additional in-product operation approval. Link to CloudChef privacy/terms and Cloudflare's authorization-management page.

On successful reauthorization:

- atomically replace the encrypted credential;
- increment `connection_generation`;
- invalidate capabilities and pending approvals tied to the old generation;
- rotate/reprovision the user runtime identity using the existing generation mechanism;
- delete the prior vault credential only after the new connection commits; and
- preserve the user's workspace and generated application data.

### Phase 4: Add a transient official MCP gateway

Create a server-only module, for example `app/lib/.server/cloudflare/cloudflare-mcp-client.ts`, with this contract:

- input: authenticated user/connection identity, connection generation, fixed account ID, tool name, validated tool input, abort signal, and invocation ID;
- token resolution: call the existing fresh-credential path as late as possible;
- transport: official MCP SDK Streamable HTTP client to the exact allowlisted HTTPS origin and `/mcp` path;
- authentication: transient `Authorization: Bearer <access-token>` header;
- output: bounded normalized MCP content plus provider/request metadata safe for policy and UI; and
- cleanup: close/discard transport and token references after each operation or tightly bounded turn.

Security requirements:

- hard-code or config-allowlist only `https://mcp.cloudflare.com/mcp`; no model-supplied MCP URL, redirects to unapproved origins, or arbitrary headers;
- pin automatic transport detection to Streamable HTTP behavior verified in Phase 0;
- set connect, list, call, and overall turn timeouts;
- cap request code/input size and response bytes; preserve Cloudflare's truncation marker;
- never include access/refresh tokens in thrown errors;
- on an authentication rejection, force-refresh once and reconnect;
- retry only a request proven rejected before execution; never blindly retry a write after a timeout, disconnect, 5xx, or ambiguous result; and
- represent an ambiguous write as `indeterminate` and ask the user/model to reconcile with a read before another mutation.

Use MCP discovery to validate the expected `docs`, `search`, and `execute` tools and their schemas. Namespace model-facing names as `cloudflare_docs`, `cloudflare_search`, and `cloudflare_execute` so they cannot collide with workspace tools. Fail closed if the required tool set or schema becomes incompatible. Emit a coarse compatibility metric without serializing schemas or user data.

The official MCP server currently runs generated `execute` code in an isolated Dynamic Worker and restricts outbound calls to Cloudflare API destinations. CloudChef must still apply its own authorization, account binding, approval, redaction, and audit policies at the client boundary.

### Phase 5: Integrate tools into the custom Pi model loop

The repository does not use the default AI SDK MCP tool path, so wire the MCP tools into the existing canonical tool layer.

Expected files include:

- `cloudchef-agent/model-tool-inputs.ts`: add namespaced MCP tool inputs or support a carefully bounded dynamic tool contract.
- `cloudchef-agent/types.ts` and `cloudchef-agent/tool.ts`: represent MCP metadata, approval state, and safe results without weakening workspace-tool types.
- `app/lib/.server/llm/workers-ai-tools.ts`: compose the official MCP tools beside workspace tools; MCP calls must not take the workspace operation lane.
- `app/lib/.server/llm/pi-tools-adapter.ts`: adapt the new tools, labels, schemas, timeouts, and approval pause result.
- `app/lib/.server/llm/builder-turn-budget.ts`: add separate discovery/read/execute budgets and caps.
- `app/lib/.server/llm/pi-agent-runner.ts` and message conversion: stop a turn cleanly at approval, persist the exact proposal, and resume from an approved/rejected result without duplicating prior work.
- `app/agents/builder-agent.ts` and `app/agents/builder-agent-schema.ts`: durable pending approval methods/state and generation-bound replay protection.
- builder system prompts/skills: search before execute, use the fixed account context, explain missing scopes honestly, and prefer the specialized deployment tool.

Keep `search_cloudflare_docs` during the first release. Remove or alias it only after the official MCP `docs` tool has proven equivalent reliability, output quality, and latency.

### Phase 6: Durable approval, secret handling, and audit

Add a pending-execution record in BuilderAgent durable storage with:

- random execution ID and tool-call ID;
- user ID, account ID, connection ID/generation, and transcript identity;
- exact bounded MCP tool name/input or encrypted exact `execute` code;
- SHA-256 digest of the exact executable proposal;
- parser-derived method/path/resource summary and risk reasons;
- status (`awaiting_approval`, `approved`, `rejected`, `executing`, `succeeded`, `failed`, `indeterminate`, `expired`);
- creation, decision, start, completion, and expiry timestamps; and
- decision/outcome metadata that contains no raw credential or API response.

Approval RPC/callables must authenticate the live user capability, compare all bound identities, use an atomic one-way status transition, and execute at most once. Multiple tabs, reconnects, duplicate clicks, stale sockets, and Builder recovery must not duplicate a mutation.

Add a user-owned audit table in a new `user-workspace-migrations/` migration for durable cross-chat history. Store only coarse operation metadata, decision, outcome, provider status/request identifiers, and code/input/result digests. Do not store raw MCP responses or secrets as audit data. Define retention and include this table in account export/deletion and the launch data inventory.

Some broad Cloudflare operations create or return credentials. Add a response-sensitivity layer for API tokens, Access service tokens, tunnel tokens, certificates/private keys, and similar values:

- raw secrets never enter the model transcript or logs;
- return a safe handle and metadata to the model;
- deliver a newly created secret only through a short-lived authenticated, one-time user-only reveal/download, or inject it directly into an approved secret destination;
- encrypt any temporarily retained secret and delete it after reveal/expiry; and
- block an endpoint until a safe response path exists if its secret-bearing result cannot be reliably isolated.

Domain registration approvals must include the exact domain, term, current price/currency returned by a fresh availability request, registrant-contact source, renewal behavior, and a clear non-refundable/billable warning. Recheck price and availability immediately before execution. If either changes, invalidate approval and ask again.

### Phase 7: Chat and settings UI

Update the chat surface to render first-class MCP tool cards rather than generic JSON:

- docs/search activity and bounded results;
- proposed Cloudflare action with risk reasons and account/resource target;
- Approve and Reject controls with disabled/in-progress/final states;
- explicit output-denied, expired, failed, and indeterminate states;
- partial-scope errors with a “Grant access” settings link; and
- secret-result handles that only the authenticated user can reveal.

Expected files include `app/components/chat/ToolUseContents.tsx`, the tool call/presentation components, `app/components/chat/useBuilderAgentChat.ts`, `cloudchef-agent/ai-compat.ts`, and `app/lib/stores/tool-activity.client.ts`.

Expose `addToolApprovalResponse` only if the Pi bridge uses AI SDK-compatible approval parts end to end. Otherwise add explicit typed BuilderAgent callables and map their durable state to the existing `approval-requested`, `approval-responded`, and `output-denied` UI message states. Do not mix two partial approval protocols.

Settings should show the grant status, manifest version, grouped granted/missing categories, last authorization time, selected account, reconnect action, and Cloudflare revoke link. Never send the encrypted credential handle or token to the client.

### Phase 8: Runtime, artifact, documentation, and policy updates

Because BuilderAgent is bundled into the user-owned workspace runtime, update the runtime Env/protocol and credential client as needed in:

- `user-workspace-runtime/src/index.ts` and `user-workspace-runtime/src/protocol.ts`;
- the control-plane runtime credential endpoint and its authentication tests;
- user-workspace migrations/runtime controls; and
- generated-app deployment policy if the new outbound MCP destination or dependency changes the trusted configuration.

Update privacy policy, terms, onboarding copy, settings copy, data inventory, retention/deletion/export documentation, incident response, and support runbooks. State that prompts may cause calls to Cloudflare's managed MCP service and that broad OAuth permissions remain constrained by explicit operation approvals.

After changing the user workspace runtime, run `pnpm run generate:artifacts`. Do not hand-edit generated bundle modules, binding types, or route trees.

## Test plan

### OAuth and persistence unit tests

- Stable, duplicate-free full scope request with `offline_access` and all required core permissions.
- Full, read-only, partial, declined, missing-core, unknown-scope, and missing-scope-metadata responses.
- PKCE/state/callback/account-selection protections remain intact.
- Refresh token required; refresh preserves recorded grant and does not pretend to expand it.
- Actual provider-granted scopes are stored separately from product capabilities.
- Legacy migration marks OAuth grants unknown and preserves capabilities.
- Concurrent reauthorization activates one credential, cleans orphaned credentials, and increments generation once.
- Production config verifier detects manifest/client/config drift without printing scope credentials.

### MCP gateway tests

- Mock Streamable HTTP MCP server for tool discovery and `docs`, `search`, and `execute` calls.
- Fresh bearer added server-side and absent from persisted state, errors, tool results, and logs.
- Fixed endpoint, fixed account binding, redirect rejection, request/response caps, and timeouts.
- One forced refresh on a pre-execution 401; no automatic retry after ambiguous execution.
- Protocol/schema drift and unexpected tools fail closed.
- `insufficient_scope`, revoked grant, partial grant, provider 4xx/5xx, truncation, and malformed MCP content.

### Approval and recovery tests

- Every initial-release `execute` pauses before network execution.
- Exact code/input digest, account, generation, transcript, and expiry checks.
- Approve once, reject, duplicate approval, stale approval, two tabs, socket reconnect, Agent hibernation, recovery, and cancellation.
- Mutation timeout becomes indeterminate and is not replayed.
- Read-only classifier corpus, if introduced, includes computed methods/paths, aliases, wrappers, GraphQL mutation/query, comments/strings, multiple calls, and obfuscation attempts.
- Domain purchase cannot run without current price/availability and exact approval.
- Secret-bearing responses are removed from model-visible output and audit records.

### End-to-end tests

- New user completes Full access sign-up and can list a harmless account resource through official MCP.
- User selects Read only or declines categories; onboarding succeeds with accurate partial state and writes are unavailable.
- Existing narrow user sees reauthorization-required, reconnects, keeps workspace data, and receives a new runtime generation.
- Search for an available domain and quote pricing without purchase.
- Intercept/mock the final Registrar registration request; assert the approval payload and exact API request without incurring a charge.
- Existing generated-app deployment still validates and publishes the exact approved revision.

### Required commands

Run focused tests while implementing, then:

```sh
pnpm run generate:artifacts
pnpm run validate
pnpm run ops
```

`pnpm run ops` remains read-only. Use a staging OAuth client and account for live provider/MCP smoke tests.

## Rollout sequence

1. Land the data-model correction, scope manifest tooling, grant-state UI, and legacy backfill with MCP disabled.
2. Verify/update the staging OAuth client and run Phase 0 consent cases.
3. Deploy code that can accept both narrow and broad callback results.
4. Update the production OAuth client allowed/optional scopes using the reviewed manifest.
5. Update production scope configuration/digest and enable broad requests for new authorizations.
6. Enable official MCP `docs`/`search` and read-only account smoke tests for internal users.
7. Roll out the existing-user reauthorization banner in cohorts.
8. Enable approval-gated `execute` for internal users, then a small cohort.
9. Enable general mutations after audit/recovery/secret-handling metrics meet thresholds.
10. Enable Registrar registration last, behind its own kill switch, after legal/support/billing review.

Use separate fail-closed controls for:

- all official MCP access;
- MCP `execute`;
- billable operations;
- credential/identity operations; and
- Registrar registration.

Disabling a flag must prevent new operations without breaking workspace reads or existing deployments. Revoking permissions from the OAuth client configuration does not narrow tokens already issued; an emergency privilege reduction requires revoking affected grants and forcing reauthorization.

## Observability and operations

Record only coarse data:

- MCP connection/discovery success, latency, and compatible tool-catalog version;
- docs/search/execute counts by risk class;
- approval requested/approved/rejected/expired;
- outcome class (`success`, `denied`, `insufficient_scope`, `failed`, `indeterminate`);
- reauthorization/grant status; and
- token refresh outcome without token or credential-handle values.

Do not log model-generated MCP code, request bodies, response bodies, domains, zone IDs, resource names, email addresses, billing data, credential material, or registrar contact data. Provide an operator-safe correlation ID shared between audit metadata and redacted logs.

Alert on repeated token refresh failures, elevated `insufficient_scope`, MCP schema drift, approval replay rejection, indeterminate mutations, secret-redaction failures, and unexpected Registrar requests. Add only read-only aggregate status to `scripts/ops-report.mjs`.

## File-level checklist

The coding agent should expect to touch or add the following areas; exact names may change if a cleaner boundary is found.

- OAuth/authentication: `app/lib/.server/cloudflare/cloudflare-oauth-orchestrator.ts`, `cloudflare-orchestrator.ts`, `cloudflare-connection-repository.ts`, `cloudflare-credential-vault.ts`, `app/server-handlers/cloudflare-integration.ts`, `app/server-handlers/runtime-credential.ts`.
- Scope/config tooling: new scope manifest/sync modules, `wrangler.jsonc`, `scripts/verify-production-config.mjs` and specs, a new explicit OAuth-client runbook/apply tool.
- Schemas/migrations: new `migrations/0016_*.sql`, new `user-workspace-migrations/0008_*.sql`, connection/data API schemas and tests.
- MCP client/policy: new server-only `cloudflare-mcp-client`, invocation policy/parser, redaction, error, and audit modules.
- Builder/model tools: `cloudchef-agent/model-tool-inputs.ts`, `cloudchef-agent/types.ts`, `app/lib/.server/llm/workers-ai-tools.ts`, `pi-tools-adapter.ts`, `pi-agent-runner.ts`, `pi-message-conversion.ts`, and turn budgets/prompts.
- Durable approval: `app/agents/builder-agent.ts`, `app/agents/builder-agent-schema.ts`, callable/protocol types, recovery tests.
- UI: `app/components/chat/ToolUseContents.tsx`, `ToolCall.tsx`, `useBuilderAgentChat.ts`, `app/components/settings/CloudflareCard.client.tsx`, `CloudflareSignInPrompt.tsx`, settings/onboarding surfaces and stores.
- Runtime/artifacts: `user-workspace-runtime/src/index.ts`, `protocol.ts`, runtime tests, trusted deployment config, generated artifacts.
- Product/legal/ops: privacy, terms, launch data inventory, incident response, support/runbook, and read-only ops report.

## Definition of done

- A new user's single Cloudflare sign-in requests the reviewed complete scope profile, with Full access selected by default in Cloudflare consent.
- CloudChef stores an encrypted refreshable credential and the authoritative actual OAuth grant, separately from product capabilities.
- An existing narrow/unknown grant cannot use broad MCP until the user reconnects.
- Ghost can discover and call the official Cloudflare API MCP with the existing credential and no second OAuth flow.
- Tokens never persist in MCP connection state or appear in model/browser/log/audit output.
- The MCP client is fixed to the official endpoint and authenticated account.
- Every `execute` is durably approval-gated in the first mutation release, exactly-once bound, recoverable, and audited.
- Domain search/price is supported, while registration cannot occur without fresh quote data and explicit exact approval.
- Secret-producing operations have a safe non-model output path or remain blocked.
- Existing workspace, inference, and exact-revision deployment invariants still pass.
- `pnpm run generate:artifacts` and `pnpm run validate` pass; production config and read-only ops verification pass.

## Primary references checked

- [Cloudflare's own MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)
- [Official Cloudflare MCP repository](https://github.com/cloudflare/mcp)
- [Cloudflare Agents SDK MCP client](https://developers.cloudflare.com/agents/tools/mcp/)
- [Create a Cloudflare OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [Authorize a Cloudflare OAuth application](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/)
- [List OAuth scopes API](https://developers.cloudflare.com/api/go/resources/iam/subresources/oauth_scopes/methods/list/)
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Cloudflare Registrar API](https://developers.cloudflare.com/registrar/registrar-api/)
- [Human-in-the-loop patterns](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/)
