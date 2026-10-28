# CloudChef

Cloudflare control plane, builder agent, user-owned workspace runtime, and generated-application template.

## Code index

- `app/server.ts` — control-plane Worker dispatch and scheduled maintenance
- `app/lib/.server/auth.ts`, `app/server-handlers/email-auth.ts`, `app/server-handlers/google-auth.ts` — sessions and sign-in (Cloudflare, Google, emailed link); a session's context is the connection it builds in
- `app/lib/cloudflare/data/organization-access.server.ts`, `app/lib/cloudflare/data/organizations.server.ts`, `app/server-handlers/organizations.ts` — organizations, invites, members, and `canUseConnection`, the one check for who may use a connection
- `app/server-handlers/projects.ts`, `app/server-handlers/runtime-projects.ts`, `app/lib/cloudflare/data/org-projects.server.ts`, `app/lib/.server/cloudflare/workers-builds.ts` — projects kept in Cloudflare Artifacts (a person's own and a team's): importing from GitHub or an uploaded ZIP (`app/lib/.server/cloudflare/zip-extract.ts`), members' view/edit roles, production requests, and the runtime's open, imported, build-status and site calls (Workers Builds)
- `app/server-handlers/github-projects.ts`, `app/lib/.server/github/` — GitHub, only as an import source: the App installation (personal or team) and its repositories, one-repository read tokens, and public repositories read by address
- `app/agents/linked-project-workspace.ts`, `app/agents/linked-project-build.ts`, `app/lib/.server/cloudflare/linked-project-client.ts` — a workspace opened from a team project: seeding from its repository, the background Workers Builds watch of what it pushes, and the runtime's `runtime-projects/*` calls
- `app/lib/.server/cloudflare/git-proxy.ts`, `user-workspace-runtime/src/git-proxy.ts`, `user-workspace-runtime/src/container-toolchain.ts` — git in the workspace container: its history set up on the container's own disk, and the `git.internal` remote the runtime's proxy answers with a short-lived token after checking access; `app/server-handlers/main-rewrite.ts` — the one way to replace main's history, its owner's `cloudchef repo rewrite-main`
- `app/lib/.server/cloudflare/project-repository.ts` (with `repository-wire.ts`, `repository-source.ts`, `zip-archive.ts`) — every project's code and history in the account's Artifacts (`env.ARTIFACTS`, namespace `cloudchef`): commits, merges, forks, read tokens for a copy's import, and ZIPs, written with isomorphic-git in memory, and imports, which stream a GitHub branch's pack straight into a push (`repository-source.ts`); `app/lib/cloudflare/data/projects.server.ts` — the browser's `projects.*` data operations and `GET /v1/projects/archive`
- `app/workflows/user-workspace-runtime-provisioning.ts` — durable background provisioning of user workspace runtimes
- `app/agents/conversation-agent.ts` — builder lifecycle and recovery
- `app/lib/.server/llm/` — model and tool orchestration; `pi-model-catalog.ts` is which models are offered (Pi's catalogs), `pi-ai-models.ts` how each is spoken to (Workers AI binding, or a provider's model through the account's AI Gateway)
- `app/server-handlers/model-settings.ts`, `app/lib/.server/cloudflare/ai-gateway-keys.ts` — Settings, Models: the account's default model and its own provider keys (BYOK) on its AI Gateway; the providers are `GATEWAY_PROVIDERS` in `app/lib/workers-ai-model.ts`
- `app/lib/.server/llm/builder-skills.ts` — the agent's skills: CloudChef's `project-stack` plus Cloudflare's official skills, vendored from github.com/cloudflare/skills into `app/lib/.server/llm/skills/cloudflare-skills.vendored.ts` (update with `pnpm run skills:sync`)
- `app/components/chat/Chat.tsx` — chat surface
- `app/lib/stores/workbench.client.ts` and `app/lib/stores/startup/` — workspace presentation and restoration
- `app/lib/cloudflare/data.server.ts`, `app/lib/cloudflare/data/`, and `app/lib/cloudflare/data-api.ts` — authenticated persistence boundary
- `app/agents/builder-deployment-command.ts` — exact-revision deployment command
- `app/lib/.server/cloudflare/user-workspace-deployment-executor.ts` — user-owned deployment execution
- `app/lib/.server/cloudflare/deployment-config.ts` — trusted generated-app deployment configuration
- `cloudchef-agent/` — shared prompts, protocol types, parsers, and tool schemas
- `user-workspace-runtime/src/index.ts` and `user-workspace-runtime/src/protocol.ts` — project storage, validation, deployment, and browser protocol
- `template/` — generated application source and security migrations
- `make-bootstrap-snapshot.js` and `scripts/verify-template.mjs` — template artifact generation and verification
- `scripts/ops-report.mjs` — read-only production status report
- `scripts/ops-session.mjs` — read-only reconstruction of one member's recent session (`ops:session`)
- `migrations/` and `cloudflare.config.ts` — control-plane schema and bindings (deployed with the cf CLI)

## Invariants

- Product code is self-contained in this repository; do not depend on sibling repositories.
- User workloads, backing resources, and inference run only in the authenticated user's Cloudflare account. Missing user resources fail closed.
- Do not hand-edit generated route trees, Worker binding types, or generated bundle modules. After changing `template/` or the workspace runtime, run `pnpm run generate:artifacts`.

## Commands

```sh
pnpm run validate
pnpm run ops
pnpm run ops:json
pnpm run ops:session -- <chat id | user email | user id> [--json] [--full]
```

The ops commands read production state through the operator's `cf` CLI login (`cf auth login`, or
`CLOUDFLARE_API_TOKEN`) and must remain read-only. What each one reads is described under Platform Status in
DEVELOPMENT.md.

## Cloudflare CLI

Use the `cf` CLI for Cloudflare work in this repository: deploys, builds and their
logs, secrets, D1, R2, Tunnels and network routes. Use Wrangler or the dashboard
only where `cf` has no command for the task. Find commands with
`cf cli search "<what you want to do>"`, then check `<command> --help`.
