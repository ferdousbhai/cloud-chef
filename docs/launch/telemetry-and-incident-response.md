# Launch telemetry and incident response

This document describes the implemented engineering controls and the decisions still required before Product Hunt. It
is not a privacy policy or legal-basis determination.

## Implemented telemetry contract

Browsers send `POST /api/client-telemetry` using a credential-free keepalive fetch, so Ghostbuild session and retired
prompt cookies are not attached. The Worker accepts only the checked-in event enum, page class, opaque UUID
journey/correlation/error-event IDs, status fields, and bounded non-negative metrics. The strict schema rejects extra
properties. Prompts, generated code, URLs, user/account/project identifiers, credentials, tokens, exception messages,
and raw tool output have no accepted field. Browser telemetry is off by default and is emitted only after the user sets
`localStorage['ghostbuild:telemetry:preference']` to `enabled` through the Privacy-page control. Global Privacy Control
and Do Not Track override that opt-in and disable emission. The endpoint requires an exact same-origin browser `Origin`
header, uses the Cloudflare-supplied client IP only as the 60-second rate-limit key, allows up to 120 requests per IP per
minute before parsing, and caps each body at 8 KiB. The IP is not included in the application event log.
These are abuse and cost controls, not proof that an analytics event is truthful; funnel and SLO data remains
operationally indicative rather than an authenticated ledger.

The launch funnel is:

`landing_viewed → cloudflare_connect_started → prompt_submitted → first_tool_completed → validation_succeeded → preview_ready → deployment_succeeded`

Explicit deployment approval was retired from the product, so the funnel has no approval stage and no event is declared
for one. `app/lib/client-telemetry-events.test.ts` fails the build if a declared event has no production emitter, or if
an emitted event is missing from the accepted enum.

When browser telemetry is enabled, operational failures use the existing typed event names, an error level, a generic
failure reason where available, and an opaque per-event ID. Each funnel stage is claimed once per journey in memory as
well as in session storage, so an emitter that runs per rendered component — the tool card that reports
`first_tool_completed` — cannot re-count a stage when session storage is cleared or unavailable. Cloudflare Worker logs
are the current ingestion store. `app/lib/client-telemetry-events.ts` defines the accepted events; browser emission and
endpoint validation are covered by `app/lib/telemetry.client.test.ts` and
`app/server-handlers/client-telemetry.test.ts`.

## Correlation

Two opaque identifiers travel with browser telemetry, and neither is an incident record:

- The **journey ID** is created in the browser, lives only in that tab's session storage, and groups events from one
  browser-session journey. It is never sent to the control plane as a join key on any other request, because promoting a
  consent-gated browser identifier into a server-side key would make it a cross-surface tracking identifier.
- The **correlation ID** is minted by the control plane in `POST /api/cloudflare/runtime-session`, returned in that
  response, and echoed back by the browser as a bounded allowlisted telemetry field. The control plane logs it beside
  the runtime-session grant with the connection generation and runtime version, and deliberately without the account it
  was issued for.

Correlation therefore joins opted-in browser funnel events to the exact control-plane request that admitted that
browser to its user-owned runtime. Because the correlation ID appears in a sampled Worker log line that also carries
that authenticated request's Cloudflare metadata, an operator with log access can, within the seven-day retention
window, relate a telemetry event to the request that issued it. This is a deliberate incident-response tradeoff: it
requires telemetry opt-in, the ID is not written to D1, and it expires with the log.

Correlation does **not** yet reach inside the user-owned runtime. Chat turns, tool operations, workspace revisions,
previews, validations, and deployments are handled by the BuilderAgent, ProjectWorkspace, and Computer in the user's own
Cloudflare account, and their `requestId` and turn IDs are independent of this correlation ID. Threading the correlation
ID through those surfaces requires a user-runtime change and remains open on #92; do not describe the funnel as
end-to-end correlated until it lands.

## Launch objectives and log retention

Before launch, the operator must configure a dashboard with conversion and latency by funnel stage and these initial
engineering objectives:

- 99.9% successful control-plane request availability over 30 days.
- 99% successful authenticated prompt admission, excluding explicit user cancellation.
- 95% of first successful tool completions within the agreed staging budget.
- 99% preview-ready success for validated revisions and 99% deployment success after a deployment is started.
- Error-budget burn alerts at 2% over one hour and 5% over 15 minutes, grouped by event and failure reason and
  deduplicated by the per-event ID.

Cloudflare Workers Logs automatically retains data for three days on Workers Free or seven days on Workers Paid, with a
maximum retention of seven days. Ghostbuild does not copy these logs to another store. An August 4, 2026 account-member
readback showed one member, the sole Super Administrator, so no other account member currently has log access. Recheck
both facts whenever the plan or account membership changes.

The exact latency budget, dashboard URLs, alert destinations, paging schedule, and backup owner are external operational
configuration and remain launch blockers until recorded here. `ferdousbhai` is the public-beta primary owner. The
twice-weekday contact-channel inspection and remaining notification drills are recorded in
`contact-channel-operations.md`.

## Incident procedure

1. Declare severity, start an incident record, name the incident commander, and assign an opaque incident ID in that
   record. This operator-assigned ID is separate from browser telemetry error-event IDs. Do not
   copy prompts, code, tokens, or raw tool output into chat or tickets.
2. Confirm scope with Worker logs and `pnpm exec wrangler tail ghostbuild --format json --search client_telemetry`.
   Correlate related browser events by journey ID, correlation ID, event, failure reason, time window, and deployment
   version; attach only the operator-assigned incident ID in the restricted incident record, not user content.
3. Stop release activity. For a control-plane regression, inspect versions with
   `pnpm exec wrangler deployments list --name ghostbuild`, then run
   `pnpm exec wrangler rollback <known-good-version-id> --name ghostbuild --message "incident rollback"` after the
   incident commander confirms the exact version.
4. Contain deployment incidents by stopping releases and revoking affected credentials through the normal
   Cloudflare connection controls. Never delete customer-owned Workers, D1, R2, Containers, or Agents as an inferred
   cleanup action.
5. Communicate initial impact, affected surface, safe workaround, and next update time through the published support and
   security channels. Their business-day acknowledgement goals are operational targets, not 24/7 incident-response or
   contractual service-level guarantees.
6. Verify recovery using the built-browser smoke gate and the staging critical journey. Monitor one full error-budget
   window before resolving.
7. Within two working days, write a blameless review covering timeline, detection gap, containment, customer impact,
   corrective owners/dates, and whether this runbook or a test gate failed.

## Containment

Ghostbuild has a server-side kill switch for new Computer-backed operations. Set `enabled = 0`, optionally with a
`reason`, on the `computer_operations` row of the `runtime_controls` table in the affected user runtime's D1 database
through the Cloudflare D1 API. New tool operations, seeds, and previews then fail closed with the typed
`computer_operations_disabled` error within ten seconds, without a redeploy. Reads, deployment-plan inspection, and
project deletion stay available, so existing durable project data remains inspectable and reclaimable while the switch
is thrown. Restore by setting `enabled = 1`.

The switch is per user runtime, because each user's runtime binds its own database. Containment across a multi-user
beta is therefore one write per affected runtime.

## Containment limits

An established WebSocket or in-flight bounded turn can continue until it settles, times out, or the operator revokes
that runtime; the kill switch refuses new work rather than interrupting work already admitted. During an incident, halt
releases and use Cloudflare operator controls only for the exact affected Worker after confirming ownership and scope.
A staging drill must inject client, Agent, sync, preview, validation, and deployment failures and verify redaction,
correlation, containment, dashboard alerts, rollback, and customer communication before launch.

## Computer dependency posture

`@cloudflare/computer` is pinned exactly and is marked preview-only upstream. Two upgrade hazards are canaried rather
than assumed:

- `patches/@cloudflare__computer@0.2.1.patch` patches the published dist bundle in two places, and any version bump must
  re-derive both; the canary fails if upstream reflows either region. It reduces `PROBE_BATCH` from 100 to 64 for the
  Durable Object SQLite bind-variable limit, and it replaces the nested branch of `Database.transactionSync` — the
  `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` path — with an inline call to the closure, because Durable Objects reject that
  SQL outright and every write nested inside an outer `transactionSync` would otherwise throw.
- The contract canaries assert the runtime surfaces Ghostbuild actually calls — `Workspace`, `WorkspaceFilesystem`,
  `WorkspaceRuntime`, and `SyncRetryScheduler` — rather than the `createAITools` tool schemas, which production does not
  execute. Only one exec backend is configured, `container-shell`.

The `minimumReleaseAgeExclude` exception for the pinned release has been removed now that the release is well past the
24-hour gate, and that pnpm-workspace key is now forbidden outright, so reintroducing it requires a reviewed policy
change. Upstream `0.2.1` is the pinned and patched version.
