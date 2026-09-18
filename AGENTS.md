# CloudChef

Cloudflare control plane, builder agent, user-owned workspace runtime, and generated-application template.

## Code index

- `app/server.ts` — control-plane Worker dispatch and scheduled maintenance
- `app/workflows/user-workspace-runtime-provisioning.ts` — durable background provisioning of user workspace runtimes
- `app/agents/builder-agent.ts` — builder lifecycle and recovery
- `app/lib/.server/chat.ts` and `app/lib/.server/llm/` — model and tool orchestration
- `app/components/chat/Chat.tsx` — chat surface
- `app/lib/stores/workbench.client.ts` and `app/lib/stores/startup/` — workspace presentation and restoration
- `app/lib/cloudflare/data.server.ts`, `app/lib/cloudflare/data/`, and `app/lib/cloudflare/data-api.ts` — authenticated persistence boundary
- `app/agents/builder-deployment-command.ts` — exact-revision deployment command
- `app/lib/.server/cloudflare/user-workspace-deployment-executor.ts` — user-owned deployment execution
- `app/lib/.server/cloudflare/deployment-config.ts` — trusted generated-app deployment configuration
- `cloudchef-agent/` — shared prompts, protocol types, parsers, and tool schemas
- `user-workspace-runtime/src/index.ts` and `user-workspace-runtime/src/protocol.ts` — project storage, previews, validation, deployment, and browser protocol
- `template/` — generated application source and security migrations
- `make-bootstrap-snapshot.js` and `scripts/verify-template.mjs` — template artifact generation and verification
- `scripts/ops-report.mjs` — read-only production status report
- `migrations/` and `wrangler.jsonc` — control-plane schema and bindings

## Invariants

- Product code is self-contained in this repository; do not depend on sibling repositories.
- User workloads, backing resources, and inference run only in the authenticated user's Cloudflare account. Missing user resources fail closed.
- Do not hand-edit generated route trees, Worker binding types, or generated bundle modules. After changing `template/` or the workspace runtime, run `pnpm run generate:artifacts`.

## Commands

```sh
pnpm run validate
pnpm run ops
pnpm run ops:json
```

The ops commands read production state through the operator's Wrangler authentication and must remain read-only.
