# CloudChef

Cloudflare control plane, builder agent, user-owned workspace runtime, and generated-application template.

## Code index

- `app/server.ts` — control-plane Worker dispatch and scheduled maintenance
- `app/lib/.server/auth.ts`, `app/server-handlers/email-auth.ts`, `app/server-handlers/google-auth.ts` — sessions and sign-in (Cloudflare, Google, emailed link); a session's context is the connection it builds in
- `app/lib/cloudflare/data/organization-access.server.ts`, `app/lib/cloudflare/data/organizations.server.ts`, `app/server-handlers/organizations.ts` — organizations, invites, members, and `canUseConnection`, the one check for who may use a connection
- `app/server-handlers/projects.ts`, `app/server-handlers/runtime-projects.ts`, `app/lib/cloudflare/data/org-projects.server.ts`, `app/lib/.server/cloudflare/workers-builds.ts` — projects kept in Cloudflare Artifacts (a person's own and a team's): importing from GitHub or an uploaded ZIP (`app/lib/.server/cloudflare/zip-extract.ts`), members' view/edit roles, and the runtime's open, imported, build-status and site calls (Workers Builds)
- `app/server-handlers/project-presence.ts`, `app/lib/cloudflare/data/project-presence.server.ts`, `app/lib/cloudflare/project-presence.client.ts` — who has a project open now (faces beside its name in the header) and what others changed since your last visit (a closable tip), kept as metadata only in `project_visits`; the History dialog's "Published by" and Live come from `GET /api/projects/<id>/main-changes`
- `app/server-handlers/github-projects.ts`, `app/lib/.server/github/` — GitHub, only as an import source: the App installation (personal or team) and its repositories, one-repository read tokens, and public repositories read by address
- `app/agents/linked-project-workspace.ts`, `app/agents/linked-project-build.ts`, `app/lib/.server/cloudflare/linked-project-client.ts` — a workspace opened from a team project: seeding from its repository, the background Workers Builds watch of what it pushes, and the runtime's `runtime-projects/*` calls
- `app/lib/.server/cloudflare/cloudflare-api-proxy.ts`, `user-workspace-runtime/src/cloudflare-api-proxy.ts` — `cf` in the workspace container: the `cloudflare-api.internal` proxy that adds the account's authorization outside the container, sends reads, holds each change an agent command asks for until the person approves it in the chat (`app/agents/builder-cloudflare-execution.ts`), sends a change typed in the person's own terminal at once, and files a team member's changes for the team's admins (`app/lib/.server/cloudflare/team-cloudflare-approvals.ts`)
- `app/lib/.server/cloudflare/git-proxy.ts`, `user-workspace-runtime/src/git-proxy.ts`, `user-workspace-runtime/src/container-toolchain.ts` — git in the workspace container: its history set up on the container's own disk, and the `git.internal` remote the runtime's proxy answers with a short-lived token after checking access; `app/server-handlers/main-rewrite.ts` — the one way to replace main's history, its owner's `cloudchef repo rewrite-main`
- `app/lib/.server/cloudflare/project-repository.ts` (with `repository-wire.ts`, `repository-source.ts`, `zip-archive.ts`) — every project's code and history in the account's Artifacts (`env.ARTIFACTS`, namespace `cloudchef`): commits, merges, forks, read tokens for a copy's import, and ZIPs, written with isomorphic-git in memory, and imports, which stream a GitHub branch's pack straight into a push (`repository-source.ts`); `app/lib/cloudflare/data/projects.server.ts` — the browser's `projects.*` data operations and `GET /v1/projects/archive`
- `app/workflows/user-workspace-runtime-provisioning.ts` — durable background provisioning of user workspace runtimes
- `app/lib/cloudflare/data/posts.server.ts`, `app/server-handlers/showcase.ts`, `app/lib/.server/showcase/`, `app/lib/showcase-loaders.ts`, `app/components/showcase/` — showcase pages and the feed: public pages at `/<username>` and posts at `/<owner>/<slug>` (server-rendered for anyone), follows, likes, comments, notifications, copies waiting for a space, reports and `/reports`; a post is made only by `projectPublished` (`jobs.ts`) from `recordProductionPublish`'s answer; screenshots by Browser Rendering from the `cloudchef-showcase` queue, media in CloudChef's own R2 (`SHOWCASE_MEDIA`, served at `/media/<id>`)
- `app/lib/reel.ts`, `app/lib/reel-files.ts`, `app/components/showcase/ReelPlayer.tsx`, `app/agents/builder-reels.ts`, `app/components/chat/ChatReels.tsx`, `user-workspace-runtime/src/reel-proxy.ts`, `app/server-handlers/runtime-reels.ts`, `app/lib/guidance/post-clip/SKILL.md` — a post's clip ("stills with motion"): the agent's pictures of the live site and `cloudchef reel`, the timeline made and spoken in the person's account, Approve / Not now in the chat, and CloudChef's own player
- `app/agents/conversation-agent.ts` — the builder: a conversation's turns on pi-durable through the Agents SDK's `PiHarness` (Stop, messages sent during a run, the handoff near the context limit, recovery); `app/agents/builder-pi.ts` its extension, settings and the chat stream to the browser, `app/agents/builder-chat-view.ts` the chat drawn from the transcript
- `app/lib/.server/llm/` — model and tool orchestration; `pi-model-catalog.ts` is which models are offered (Pi's catalogs), `pi-ai-models.ts` how each is spoken to (Workers AI binding, or a provider's model through the account's AI Gateway), `builder-models.ts` that as pi-ai `Models`, `builder-tools.ts` the four tools as pi-durable tools, `handoff.ts` the handoff note
- `app/server-handlers/model-settings.ts`, `app/lib/.server/cloudflare/ai-gateway-keys.ts` — Settings, Models: the account's default model and its own provider keys (BYOK) on its AI Gateway; the providers are `GATEWAY_PROVIDERS` in `app/lib/workers-ai-model.ts`
- `app/lib/.server/llm/builder-skills.ts` — the agent's skills: CloudChef's `project-stack` plus Cloudflare's official skills, vendored from github.com/cloudflare/skills into `app/lib/.server/llm/skills/cloudflare-skills.vendored.ts` (update with `pnpm run skills:sync`)
- `app/components/chat/Chat.tsx` — chat surface; `app/components/chat/useConversationAgentChat.ts` its connection to the agent (chat frames in, messages and Stop out)
- `app/lib/stores/workbench.client.ts` and `app/lib/stores/startup/` — workspace presentation and restoration
- `app/lib/cloudflare/data.server.ts`, `app/lib/cloudflare/data/`, and `app/lib/cloudflare/data-api.ts` — authenticated persistence boundary
- `user-workspace-runtime/src/project-builder.ts`, `user-workspace-runtime/src/app-build.ts`, `app/lib/.server/cloudflare/project-build-plan.ts`, `app/lib/.server/cloudflare/deploy-api-policy.ts` — publishing a project CloudChef deploys itself (a chat's app, an uploaded ZIP, history pushed from a computer): each pushed commit is built and deployed in the person's account (main goes live, a branch makes a preview), a starter app with its resources made and its migrations applied; `app/server-handlers/runtime-deployments.ts` and `app/lib/cloudflare/data/project-deployments.server.ts` — the control plane's record of each publish (`recordProductionPublish` in `org-projects.server.ts` for what went live)
- `cloudchef-agent/` — shared prompts, protocol types, parsers, and tool schemas
- `user-workspace-runtime/src/index.ts` and `user-workspace-runtime/src/protocol.ts` — project storage, validation, and browser protocol
- `user-workspace-runtime/src/computer-sandbox.ts`, `base-container.ts`, `container-process.ts`, `workspace-terminal.ts` — the workspace container on the `durable_object` scheduling policy (Computer's `ContainerBackend` through CloudChef's own host, the Container API): Cloudflare's managed image set up once per runtime and kept as its base snapshot, which later starts restore; provisioning moves platform-scheduled applications over inside the upgrade window (`ensureWorkspaceRuntimeContainer` in `app/lib/.server/cloudflare/user-account-api.ts`), and the canary gate for runtime upgrades (`app/lib/.server/cloudflare/user-workspace-runtime-rollout.ts`)
- `template/` — generated application source and security migrations
- `make-bootstrap-snapshot.js` and `scripts/verify-template.mjs` — template artifact generation and verification
- `scripts/ops-report.mjs` — read-only production status report
- `scripts/ops-session.mjs` — read-only reconstruction of one member's recent session (`ops:session`)
- `migrations/` and `cloudflare.config.ts` — control-plane schema and bindings (deployed with the cf CLI)

## Invariants

- Product code is self-contained in this repository; do not depend on sibling repositories.
- User workloads, backing resources, and inference run only in the authenticated user's Cloudflare account. Missing user resources fail closed. Exception, showcase media only: a public project's screenshot, taken by Browser Rendering in CloudChef's own account loading the site's public address as any visitor would, is stored in CloudChef's own R2 and served by CloudChef, and so is a post's clip once its author approves it in the chat (pictures and spoken lines made in their own account); no project code, data, chat or build output is stored or run there, and removing the post, making the project private, or erasing the author's account deletes it.
- Every new top-level page is added to `RESERVED` in `app/lib/usernames.ts` first: people's pages are at `/<username>`.
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
