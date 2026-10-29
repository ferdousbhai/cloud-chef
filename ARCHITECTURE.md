# Architecture

This file records boundaries that are difficult to infer from one module. Use [AGENTS.md](AGENTS.md) to locate the
implementations.

## Dependency Direction

```text
route or view
  -> controller or orchestration service
    -> domain policy or model
      -> repository or platform adapter
```

Views render state and forward events. Orchestrators coordinate use cases. Domain policies remain independent of React
and platform bindings. Repositories and adapters own D1, R2, Durable Object, Workers AI, Sandbox, and HTTP details.
Lower layers receive narrow capabilities instead of importing application-wide stores.

## Account Boundary

CloudChef is a control plane, not the host for customer projects. Its Worker and D1 retain identity, encrypted
Cloudflare authorization, authentication state, connection metadata, runtime locators, and privacy-filtered operational
events. The root deployment has no Container or application Durable Object binding. Its one Workflow binding durably
provisions user-owned workspace runtimes without holding the browser's runtime-session request open.

Opening a project after Cloudflare is connected queues a durable control-plane Workflow that provisions a workspace Worker, D1 database,
`ConversationAgent` Durable Objects, and a `ProjectWorkspace` Durable Object backed by a Cloudflare Container in that user's
account. Runtime-session requests return `workspace_preparing` while that Workflow runs, and the browser polls with
bounded backoff instead of holding the provisioning request open. Once ready, the browser receives a short-lived,
origin-bound capability and communicates directly with that Worker for chat, project, and deployment
operations. Generated-application D1 and R2 resources are created later only when the validated deployment plan
requires them. Cloudflare meters those resources to the user's account.

## Runtime Upgrades

Redeploying a workspace Worker resets its Durable Objects, which ends whatever they are running. A CloudChef
release therefore never redeploys a runtime that is working. `USER_WORKSPACE_RUNTIME_SHA256` is the digest of the
runtime bundle itself, so a control-plane-only release leaves every runtime alone.

The control plane and a workspace runtime run the same build. Neither carries fallbacks for an older counterpart:
a runtime from an earlier release is upgraded rather than spoken to in an older protocol. While one serves the same
connection generation and speaks the same `USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION`
(`user-workspace-runtime/src/protocol.ts`), the runtime-session request keeps issuing sessions for it and starts the
provisioning Workflow in the background, so a running conversation is never cut off; the browser shows no
preparation. A missing runtime, one for an earlier connection generation, or one speaking another protocol is
prepared before a session is issued, and the browser shows the workspace being upgraded. A
runtime of an earlier generation (a reconnect, whose redeploy rotates its secret) still waits for the upgrade window,
asked with the secret derived for the generation it was deployed with; one that refuses that secret and the new
one is redeployed at once, as a first workspace is. That wait is capped at 15 minutes from when the Workflow found
the runtime live (`EARLIER_GENERATION_MAX_WAIT_MS`, measured from that recorded step result, so a replay or retry
keeps it), after which the runtime is redeployed as a first workspace is, ending whatever still runs: its member
gets no session for a runtime of an earlier generation, so cannot Stop the turn holding it back (a turn may run four
hours), and a busy row left by a reset would hold it for the whole lease with nothing to clear it. A wait for a
runtime of the same generation is not capped, since its member keeps a session meanwhile.

The runtime is the source of truth for whether it is busy, since a turn keeps running with no tab open. Every
`ConversationAgent` records in the runtime's D1 (`runtime_activity`) whether it is working, and for two minutes after it
stops. Its turn (and the validation it runs) counts from its state; a production publication, an
approved Cloudflare request, a GitHub build watch, and seeding a new workspace count while their work actually runs
(`BuilderRuntimeActivity.run` in `app/agents/builder-runtime-activity.ts`), never from the deployment
record in state, which an editor save rewrites while that work continues. Before redeploying,
the Workflow asks the runtime, with its secret, for the upgrade window (`POST /v1/upgrade-window`): one statement
grants it only when no row is active. It then redeploys the Worker, configures it, replaces any container application
still on the platform-scheduled policy (The container scheduling policy, below), and waits for the new runtime to be
ready, renewing the window on the new runtime (`PUT`) throughout, and releases it (`DELETE`) once the runtime serves;
deleting an application ends its running containers at once, so nothing may start before it completes. Each of these is its own Workflow step, so a retry never claims the window again or redeploys. Each
call names the Workflow instance holding the window (a `cloudchef-upgrade-holder` header, which every call must
carry): another upgrade's claim or renewal is refused while it is open, as for a busy workspace, and only its holder
releases it. The holder's
own claim of its window still open is granted whatever is busy, so a retried deploy step (which may find the Worker
it already redeployed) keeps the window rather than letting it lapse under work waiting for it. Work
that starts records itself first and then waits while any window is open, on the old Worker or the new one; a
window lapses five minutes after its last renewal, which bounds the wait when an upgrade stops partway. A turn
waits at most three minutes, then asks to be sent again; a Stop calls its wait off. A step's retries can outlast
the window, so the runtime renews a lapsed window only while nothing is busy (`409` otherwise): work that started
meanwhile would be cut off by the replacement, and the Workflow waits for it as for a busy workspace, without
redeploying again. Work that cannot record itself or read the window retries for a minute before it starts anyway.
A busy workspace is asked again with backoff (30 seconds doubling to 5 minutes); after 12 hours the Workflow ends without upgrading, and the
next session request, or the next sweep, starts another. That limit applies only before the redeploy: once the new
Worker serves, the steps after it wait, with the same backoff, for as long as work keeps them from the window, since
that Worker still needs its container applications, its schedule and its readiness check. A Workflow restarted partway
claims the window again and redeploys only once the workspace is idle, so it never cuts work off.

A runtime whose owner does not come back would otherwise stay on an old release, and a failed upgrade would stay
failed until the browser's explicit retry. The control plane's 15-minute cron therefore also sweeps
(`app/lib/.server/cloudflare/user-workspace-runtime-upgrade-sweep.ts`): it lists ready runtimes that are outdated but
still serve their connection's generation and protocol, all of them, most recently used first, skips anyone who may
no longer use the connection, and starts or restarts the same gated Workflow instance a session request would name,
until it has launched 10 (`UPGRADE_SWEEP_MAX_LAUNCHES`); upgrades still waiting don't count toward that cap, so they
never keep a sweep from the rest. An upgrade still waiting is left alone; one that gave up waiting is restarted; one that failed is
restarted on one sweep in four, so at most hourly, unless it failed after redeploying the Worker (which then serves
without its container applications or schedule), which every sweep restarts. First-time provisioning never goes through the sweep: it lists only
runtimes that are already ready. A busy row a Durable Object never cleared stops counting after the turn wall clock
plus 30 minutes.

A release can upgrade one person's runtime first. `WORKSPACE_RUNTIME_UPGRADE_CANARY` in `cloudflare.config.ts` is
empty, which upgrades everyone, or a comma-separated list of CloudChef user ids, which upgrades only theirs: neither a
session request nor the sweep starts the upgrade of anyone else's runtime, which keeps serving as a deferred one does
(`user-workspace-runtime-rollout.ts`). A first workspace is always prepared on the current release. The variable is
changed by a release, never in the dashboard. A runtime also records the container identity it runs on
(`USER_WORKSPACE_IMAGE` in `user-workspace-image.ts`: the managed image and the `durable_object` policy), so a runtime
whose applications are still platform-scheduled is outdated, as one on an earlier runtime build is.

Because a deferred runtime keeps serving the current browser and control plane until it is idle, a release whose
browser or control-plane calls that runtime cannot serve bumps the protocol version, and user-workspace D1
migrations, applied before the deferred redeploy, must be additive.

## Accounts, Organizations, and Contexts

A Cloudflare connection belongs to one person (their own account) or to an organization (its admins connect the
organization's account once). Sign-in is separate from connecting: Cloudflare, Google, or an emailed one-time link
creates a session, and a session works in one context, a connection the person may use, chosen with the workspace
switcher; a tab names the context it opened in on each runtime-session request and reloads if another tab switched
the session. People without Cloudflare logins of their own build in an organization's account.

Each person gets their own workspace runtime per connection, named from `sha256(accountId:userId)` for their own
account and `sha256(accountId:userId:connectionId)` for an organization's (with the runtime secret bound the same
way), so a person's own and organization workspaces never collide, and members of one
organization have separate Workers, D1 databases, Durable Objects, and containers in its account, keyed in
`user_computer_runtimes` by (user, connection). Every control-plane path that hands out a workspace or a token asks
one question, `canUseConnection` (`app/lib/cloudflare/data/organization-access.server.ts`): the connection's owner, or
an active, unpaused member of the organization that owns it. The credential broker asks it after the runtime proves
its secret, so pausing or removing a member stops their runtime at its next call, without a
redeploy. Every runtime route (`/api/cloudflare/runtime-*`, `app/server-handlers/runtime-authentication.ts`) takes
the runtime's identity in headers beside its secret and checks both before reading a body, which for a commit can be
48 MB, and refuses a call that lacks them. Each
secret may make 600 calls a minute (`RUNTIME_RATE_LIMITER`). In an organization's account the runtime also asks the
control plane (`/api/cloudflare/runtime-access`) before each model turn, since the model runs on the organization's
Workers AI without a token from the broker; in a shared account (`CLOUDCHEF_SHARED_ACCOUNT`) the same answer decides,
each time it is asked, whether `cf` in the workspace reads the account directly, which only the
organization's active admins may, so a demoted admin loses it at once.
The same answer carries the person's own AI Gateway content-logging choice (`user.ai_gateway_content_logging`,
set in Settings), which the runtime asks for before every builder turn and title in any
account: model requests always go through the account's default gateway, logged (and labelled with chat and
person) only when that answer says so. An unreachable control plane or a missing answer means unlogged, and no
organization setting overrides a person's opt-out. A member's
runtime reports each model turn's token counts to `/api/cloudflare/runtime-usage`, authenticated the same way, and the
control plane keeps per-day counts for the organization's admins; no content reaches it.

The models a workspace offers come from Pi's catalogs (`app/lib/.server/llm/pi-model-catalog.ts`): the
account's live Workers AI catalog where Pi lists the model, and each AI Gateway provider's models while the
account's default AI Gateway holds a key for that provider. The providers are a table (`GATEWAY_PROVIDERS` in
`app/lib/workers-ai-model.ts`, and where Pi lists each one's models in `pi-model-catalog.ts`): Anthropic and OpenAI
from Pi's `cloudflare-ai-gateway` catalog, xAI (gateway slug `grok`) and OpenRouter from Pi's own catalogs for them.
A gateway model's id is the provider's slug and Pi's model id (`anthropic/claude-opus-5-5`,
`openrouter/openai/gpt-5`). Only models on a Pi API with a transport in `pi-ai-models.ts` (Anthropic Messages,
OpenAI Responses, OpenAI Completions) and a window of at least 32,768 tokens are offered, and a model Pi does not
list is not offered. Two providers are not offered: Google AI Studio, because Pi's Google Generative AI client
refuses a custom fetch and so cannot be carried by the binding, and Fireworks, which AI Gateway has no provider for.

Every key is the account's own (BYOK), kept in its Secrets Store and attached to the default gateway as a provider
key, and nothing about it is CloudChef's: the control plane reads the gateway's provider keys from the account each
time, whoever added them, and uses each provider's default key, or its newest, under whatever alias it has. An
organization's admins, or the person whose own account it is, can also paste a key in Settings, with the
connection's Cloudflare authorization (`aig.write`, `secrets-store.write`); it goes to Cloudflare once, never into
CloudChef's storage. Cloudflare's BYOK flow is the only one: it takes a pasted key and stores it as the secret
`default_{provider}_cloudchef` (alias `cloudchef`, CloudChef's name, so relinking and unlinking delete it), and only
on a gateway with authentication on and a Secrets Store linked. Linking replaces the provider's keys on the gateway,
including one added in Cloudflare, which Settings says first; unlinking removes only CloudChef's. Linking first
readies the gateway: one with both is left alone, one missing either is written back whole (Cloudflare's update
replaces the gateway) with every other setting kept, authentication on, and the account's first store linked if it
had none, and a missing gateway is created that way. Turning authentication on is reported in Settings, since the
account's own apps calling the gateway over HTTP then need a gateway token; the runtime's Worker binding needs none.
Linking an existing Secrets Store secret is not offered: Cloudflare's provider keys do not find one, however it is
named.

A gateway model's request runs Pi's implementation of the provider's API in the runtime and is sent by the Workers
AI binding as a universal request to `env.AI.gateway('default')`, at the provider's slug and the endpoint the SDK
asked for, which the gateway authenticates as the account itself: no gateway token exists and no provider credential
leaves the Worker, so the gateway adds the stored key, the one `cf-aig-byok-alias` names when it is not the
provider's default. The logging choice above rides as `cf-aig-*` headers. The runtime asks the control plane
(`/api/cloudflare/runtime-models`) for its catalog and before each gateway model's turn which keys (provider and
alias) are on the gateway, which the control plane asks Cloudflare each time; no answer means only Workers AI. The
same answer carries the account's default model (`cloudflare_connections.default_builder_model`), chosen by its
admins; everyone can still switch, and a saved choice the account no longer offers falls back to it.

An organization's authorization reaches every workspace in its account, which is why only its admins get the
account's direct reads through `cf` in a shared account (above). A member's changes go through the deployment pipeline
or Workers Builds, which touch only their own resources.

An organization keeps at least one active admin. Erasing a member's account never revokes the organization's
authorization; erasing its last member removes the organization and revokes it.

## Projects

A project's code and history live in Cloudflare Artifacts, in the account the project belongs to: an Artifacts
repository in the account's `cloudchef` namespace. A project belongs to a Cloudflare connection
(`org_projects.connection_id`): a team's, whose admins own every project and give each member a role on the ones
they choose (view or edit, `org_project_access.role`; invites grant edit), or a person's own, whose only member is
its owner (`app/server-handlers/projects.ts`, `app/lib/cloudflare/data/org-projects.server.ts`). Who may do what
is decided in one query (`findAccessibleProject`): a paused or removed member has no role at their next call.

GitHub is only where a project may be imported from, once; nothing is read back from it afterwards. A public
repository is imported by its address (its default branch read from the ref advertisement GitHub serves without
credentials, so no GitHub token is needed); a private one through CloudChef's GitHub App, which a team's admin, or a
person for their own projects, installs on the GitHub account holding it (`app/server-handlers/github-projects.ts`).
The installation is recorded for the connection only after the returning person's own GitHub authorization shows
they control it: their own account, or a GitHub organization they own. No GitHub token is stored. Importing makes
the project at once, with its source (`import_repo_full_name`, `import_branch`) and no repository; the first member
who may edit it and opens it imports it: their workspace runtime asks the control plane
(`/api/cloudflare/runtime-projects/open`), which answers with the source and, for a private repository, a fresh App
token limited to it and read-only, then clones it into `t-<project id>` with full history, its default branch
becoming `main`, and reports the repository (`/runtime-projects/imported`, recorded once).

The runtime reads and writes the repository itself, through its Artifacts binding in the same account. Its calls
to the control plane (`app/server-handlers/runtime-projects.ts`) are authenticated like the credential broker, and
each re-checks the member's role and that the project belongs to the connection the runtime runs for. A member's
changes reach the repository as their agent pushes them with git: a branch it names for a preview, `main` to
publish.

CloudChef never builds or deploys a project kept in Artifacts. Workers Builds, connected to the repository,
deploys `main` (the only production branch Artifacts supports) and builds other branches into Previews. The
control plane reads what it reports with the connection's own authorization (`workers-ci.read`), never handing
a team's token to a member (`app/lib/.server/cloudflare/workers-builds.ts`): the project's Worker is found by the
repository its latest build came from (its Artifacts repository, or the GitHub one it was imported from, until
its builds are switched) and remembered (`workers_builds_script_tag`); `/runtime-projects/status` matches a
commit to its build, and `/runtime-projects/site` reports the Worker's production and Preview origins, which each
turn's context names so the agent knows where the live site is (it reads it with `curl`, like any address). Workers Builds' API names no Artifacts provider for a repository
connection, so moving an imported project's builds from GitHub to Artifacts is done in Cloudflare's dashboard;
`/api/projects/<id>/workers-builds/switch` says when it is done, and otherwise how.

A member's new app (a draft) can be sent for review: the request names the draft's own repository (`p-<chat>`) and
the commit sent. Approving it, in one step, makes that repository a team project its requester may edit, adopted
as it is; an admin then connects it to Workers Builds. An admin can also limit a member to the team's projects:
that member's runtime is refused the team's Cloudflare token by the credential broker, so their work reaches
production only through Workers Builds.

## Project Repositories

Every project's code and history live in Cloudflare Artifacts in the account the project belongs to, through the
runtime's `ARTIFACTS` binding (namespace `cloudchef`, created on first use). A CloudChef app's repository is
`p-<chat initial id>`; a team project's is the one the control plane records for it (`t-<project id>` once
imported). Artifacts reads trees, blobs and history and makes repositories, forks, imports and tokens, but has no
server-side commit or merge, so `app/lib/.server/cloudflare/project-repository.ts` writes those with isomorphic-git
into an in-memory object store (never the workspace, which holds no `.git`) and pushes them over git's smart HTTP
with a short-lived write token. Every ref update names the value it read, so a branch someone else moved is a
conflict, never an overwrite. A commit writes the whole tree (a file left out is deleted), sending only blobs its
parent lacks; installed and built output, local secrets (`.env*`, `.dev.vars*`) and what the project's
`.gitignore` files ignore never go in.

The agent works on a project's history with plain git in its workspace container. The history lives on the
container's own disk (`GIT_DIR=/opt/cloudchef/git/project.git`, the worktree `/home/project`), outside the durably
stored `/home`, and is set up again from the repository on first use in each container
(`user-workspace-runtime/src/container-toolchain.ts`): based on the commit the workspace's files match, so others'
later commits never show as changes undone, with secret files and build output excluded and hooks that refuse
committing `.env`/`.dev.vars` and rewriting main. Its remote is `http://git.internal/project.git`, which the
runtime's `GitProxy` (`user-workspace-runtime/src/git-proxy.ts`, `app/lib/.server/cloudflare/git-proxy.ts`) answers:
it checks the person's access on each request, adds a short-lived Artifacts token the container never sees, refuses
deleting main or pushing anything but branches and tags, and records the refs a push updated. A push moves main only
as a fast-forward from the commit git read, so no push rewrites it. Replacing main's history on purpose (to drop large
files from old commits) is the project owner's, or a team admin's, `cloudchef repo rewrite-main BRANCH`
(`app/server-handlers/main-rewrite.ts`, then the runtime's `POST /v1/projects/rewrite-main`): main moves to the pushed
branch's commit only from the commit the owner read, never with a secret file main didn't hold, is recorded in
`project_main_rewrites`, and publishes as a push to main does. A CloudChef app's
production serves main: a turn that pushed main publishes it, with its exact-revision deployment, and only while the
workspace holds exactly what main does. `revertToCommit` applies an earlier commit's files as one compare-and-swap
change set (refused while a turn runs), commits them as `Restore version <short commit>`, and the ordinary publication
follows. A fork copies the repository to the new chat's own `p-<id>` (main moved back to the chosen commit) and the
new chat's workspace seeds from it. A team project's workspace seeds from its main (importing it first, when the
control plane gives an import source); a push of a branch makes a preview and a push of main publishes, each shown
in the pushing command's card while a background watch reads Workers Builds' status for the commit from the control
plane (`runtime-projects/status`). The browser
reads history, a clone command, a fork and a ZIP of any commit through the runtime (`projects.*` data operations and
`GET /v1/projects/archive`), with a chat's creator alone for a CloudChef app and the control plane's role (view or
edit) for a team project.

## State Ownership

| State                                                                                             | Authoritative owner                                  |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Identity, OAuth credentials, sessions, connection metadata, runtime locators                      | CloudChef control-plane D1                           |
| Organizations, memberships, invites, per-member daily usage counts                                | CloudChef control-plane D1                           |
| Projects, members' roles, GitHub installations, production requests                               | CloudChef control-plane D1                           |
| Chat catalog, transcript identity, deployment plans and resources, Agent garbage-collection queue | User workspace D1                                    |
| Conversation transcript, runs, tool calls, inbox, usage, and their recovery (pi-durable)          | User-owned `ConversationAgent` DO SQLite (`pi_*`)    |
| Project bytes, numeric revision, change index, tool journal, and validation receipts              | User-owned `ProjectWorkspace` Computer VFS/DO SQLite |
| Dependency installation, validation, and deployable artifact preparation                          | User-owned `ProjectWorkspace` Container backend      |
| Production-version upload and promotion                                                           | User's Cloudflare account APIs                       |
| Query collections and editor files                                                                | Rebuildable in-memory browser presentation cache     |
| Generated application's Worker, D1, R2, Agent, and related resources                              | User's Cloudflare account                            |

Do not create a second authoritative store for the same state. Browser and process-local materializations must be
rebuildable from their owner. Cloudflare Computer's SQLite VFS in `ProjectWorkspace` is the sole authority for project
files; the browser editor and container mount are replicas of that state.

## Transcript Reconciliation

Each `ConversationAgent` hosts one pi-durable conversation (`@earendil-works/pi-durable`, pinned exactly), opened by the
Agents SDK's `PiHarness` over the object's own SQLite under the `pi_` table prefix. Its transcript is the only
authoritative one: the model's context, the chat the person sees, reload, recovery and the handoff all read it. Every
input, model response, tool call and tool result is committed before anything is shown, so a restarted object
reopens pi and goes on where it stopped (`PiHarness`'s one Lifecycle job wakes it; pi's `onWake` drives that job, not
the SDK's `schedule()`). A tool call a restart cut off reports `interrupted` to the model rather than running again,
except `read`; pi parks a task that keeps crashing the object (`restartLimit`). User workspace D1 stores only routing and
catalog facts: the Agent name, subchat index, branch ancestry, and whether the chat has accepted content.

The browser never sends history. It sends a message (`sendMessage`), a message during a run (`steerActiveTurn`, which
pi places after the current round of tool calls), or Stop (`cancelActiveTurn`, pi's `abort()`), and receives the chat
over the Agent's socket: after each commit the agent derives the chat's messages from every entry of the transcript
(not only the model's current context) and `pi.live` (`app/agents/builder-chat-view.ts`), and sends what changed as a
`cloudchef_chat` frame (`cloudchef-agent/chat-frame.ts`); a connecting browser gets the whole chat. The browser's
messages are a rebuildable view of that.

- A message is placed as a `cloudchef.user` entry: the model sees its text with the turn's workspace context, which is
  what the transcript keeps; the chat shows the text.
- Display-only entries change nothing the model sees: `cloudchef.handoff` (a handoff note), `cloudchef.tool-output` (a
  finished command's output as it is now: a team build's result, or an admin's decision), and `cloudchef.legacy` (a
  message of a chat from before pi-durable).
- The agent keeps only the turn's own bookkeeping in its state: which pi operation the turn waits for, so a restarted
  agent waits for it again and then publishes what the turn pushed.
- A chat from before pi-durable is converted once when its agent starts: AI Chat's messages become `cloudchef.legacy`
  entries. Such a chat goes on in a fresh context: the model does not see the old messages. AI Chat's tables are left in
  place, unused, so a rollback to the release before keeps every chat; a later release drops them (a drop takes two
  releases).
- The checkpoint the data API returns for a transcript (reload, a subchat's branch point) is derived from the chat's
  messages; it is not stored.

The Agents SDK writes its own tables (state, schedules, fibers) straight to `ctx.storage.sql`, outside pi's operation
queue, so the agent makes no SDK write inside a pi commit callback.

pi-durable migrates its SQLite schema when it opens (1.4.0 writes schema version 2). A migrated object cannot be opened
by an earlier pi-durable, so a deployment cannot roll back past the release that moved to 1.4.0, and a later pi-durable
release that migrates again sets a new floor.

## Project Lifecycle

`ConversationAgent` owns conversation execution and delegates project operations to `ProjectWorkspace`. Cloudflare Computer
stores files directly in the Durable Object's SQLite VFS. Its container backend projects the same files into the
Container through FUSE and reconciles changes back to the VFS.

The model has four tools (`cloudchef-agent/model-tool-inputs.ts`, `app/lib/.server/llm/workers-ai-tools.ts`):
`read`, `write`, `edit` and `exec`, run as pi-durable tools (`app/lib/.server/llm/builder-tools.ts`). `read`
is answered from the Durable Object's SQLite VFS alone — no container, no sync barrier, and never the exclusive
workspace operation lane, so it answers before the container is warm and stays available while a build command holds
the lane. `write`, `edit` and `exec` change the project or run in its Container under that lane. All four are
CloudChef's own: `read` returns a file's text from a line offset, `edit` replaces exact text that occurs once (or every
occurrence when asked), `write` honours the turn's abort signal, and `exec` streams its output and runs what it is
asked except a command that touches CloudChef's platform processes and state or asks `cf` for a credential
(`cloudchef-agent/workspace-boundary.ts`). `exec` answers two commands itself rather than in the shell: `pnpm add`
and `pnpm install --lockfile-only` resolve npm registry packages in a staging copy, and `cloudchef validate`, run as a
command of its own, runs the project's full validation, the one a publish reuses for the same revision (the container's
own `cloudchef` program only says so when it is reached any other way). Listing and searching files are ordinary
commands (`ls`, `find`, `grep`, `rg`). `@cloudflare/computer/tools` contributes only types.

The container has internet access: commands run there, by the agent or typed by the person in the terminal, reach
the public internet directly (package registries, documentation, the project's own live and preview sites, any other
address).
What a command may do with CloudChef's and Cloudflare's own services is decided where it leaves the container, by the
per-host proxies the ProjectWorkspace intercepts for its container (`interceptWorkspaceOutbound`,
`user-workspace-runtime/src/computer-sandbox.ts`), not by tools of their own: `git.internal` for the project's
repository (below, under Project Repositories) and `cloudflare-api.internal` for Cloudflare's API (below). The container
holds no credential for either.

Reference guidance is mostly retrieved rather than mirrored. Cloudflare's documentation is searched live with
`cf docs search` in the workspace, which needs no login and returns ranked pages; a page is read as markdown with
`curl -H 'Accept: text/markdown'`.
Framework references are read from the packages the project itself installed, so they always match the version it
builds against. The builder's skills (`app/lib/.server/llm/builder-skills.ts`) are bundled into the Worker: CloudChef's
own `project-stack`, which covers only what is specific to its starter app, and Cloudflare's official skills, vendored
from github.com/cloudflare/skills at a pinned commit into `app/lib/.server/llm/skills/cloudflare-skills.vendored.ts`
by `pnpm run skills:sync` (optionally `-- <commit>`; never edited by hand), so they stay Cloudflare's current guidance
rather than a hand-written copy. They are exposed
through the existing `read` tool under `/__skills__/<skill>/`; no activation or separate resource-reader tool is
added. That namespace is a read-only control-plane overlay: it never enters the project VFS, revision, or deployment
artifact, project files cannot shadow it, and it is not in the container, so no command sees it. The system prompt (`cloudchef-agent/prompts/system.ts`) describes only the environment — the workspace and
its tools, the kind of project (a CloudChef app, or a team's GitHub project, whose catalog omits project-stack), and
how changes are published — and leaves to the model what it can decide itself; concrete product and API guidance
comes from retrieval, while code and deployment boundaries remain enforced by project validation. A documentation search that fails returns a failed tool result the model can
act on, rather than ending the turn.

Cloudflare account work goes through Cloudflare's `cf` CLI in the container. Its launcher installs the pinned CLI on
first use and points it at `http://cloudflare-api.internal/client/v4` (`CLOUDFLARE_API_BASE_URL`) with a stand-in
token; the runtime's CloudflareApiProxy (`user-workspace-runtime/src/cloudflare-api-proxy.ts`, its rules in
`app/lib/.server/cloudflare/cloudflare-api-proxy.ts`) answers that address. It rebuilds each request as a canonical
one (the public v4 API only, and only the connected account; a change's body JSON and at most 60 KiB) and never
forwards the container's headers. A read (GET) is sent at once with a fresh access token from the credential broker,
in the person's own account or, in a team's, only for its active admins; Cloudflare's answer passes back with no
headers but its type and ray id. Any other method is a change: the proxy asks the ProjectWorkspace which agent
command is running (the workspace notes each agent's `exec` by its tool call while it runs).

A change asked for while an agent command runs is the agent's. The agent records it as a durable, expiring proposal
bound to the account, connection, transcript, that command's tool call and the exact request digest, after CloudChef's
domain review, and the chat shows it in that command's card with Approve and Reject. A command may ask for several
changes: each waits in the same card in turn, one at a time (`cf` sends them one after another; one that arrives
while an earlier one of the same command still waits or is being sent is queued, and the proxy asks again until its
turn, provided the command still runs). The proxy holds `cf`'s request and asks the agent every 1.5 s until the
proposal is settled, then answers with Cloudflare's own answer to the approved request (content that looks like a
credential withheld), or why nothing was sent. The approval expires after 15 minutes, inside `exec`'s own deadline; a
command that ends first withdraws whatever change of it still waits, so a late approval can never send it; an
interrupted approved request is marked indeterminate rather than replayed. A team member's change is filed for the
team's admins instead (`runtime-projects/approvals/file`, `source` 'agent') and `cf` is answered at once that it was
sent to them; the command's output keeps each filed change (`cloudflareChanges`), and the admins' decision replaces
it there. Each change of a command is filed under its own `change_number`: the first keeps the command's tool call id
as its key, a later one is keyed `<tool call id>#<n>`, so `UNIQUE (agent_name, tool_call_id)` still makes filing the
same change twice answer the one already filed.

A change asked for with no agent command running came from the person's own terminal, typed by them, so it needs no
approval: when they may change the account (its owner, or one of a team's admins, the same check a read makes) the
proxy sends it at once with the account's credential, with the same account and path checks, JSON and size rules and
header stripping as any request, answers with Cloudflare's answer, and logs it to the workspace runtime's log
(`cloudflare_change_from_terminal`: who, which account, method, path, status and ray id), since no approval records
it. A team member's terminal change is filed for the team's admins as the agent's are, recorded with `source`
'terminal' and no conversation (`approval_requests`, migration 0051, which only adds columns); the Approvals page says the member typed it,
and its result is shown there rather than in a chat. The proxy tells the terminal from the agent only by whether an
agent command is running at that moment: a process the agent starts in the background and leaves running after its
command ends has no command any more, so a change it asks for later is treated as typed in the terminal and is sent
without approval (or filed for the team's admins). Nothing closes that gap; the agent is told that each change waits
for approval in its command, and a change from the terminal is logged.

Model tools and editor reads use the same workspace API. Browser saves use
compare-and-swap against the numeric revision the browser loaded; a conflict refreshes from the user runtime and never
overwrites newer state. TanStack DB collections are in-memory presentation caches rebuilt from the user runtime. The
browser has no second SQLite or OPFS copy of chats, transcripts, or workspace files.

The user workspace is a separate workspace package, `@cloudchef/user-workspace-runtime`. Its `./protocol` export is
the only shared source for sync limits, request/result types, and readiness contracts. The runtime owns
the `ProjectWorkspace` implementation; `computer-sandbox.ts` contains the Cloudflare Computer container adapter on the
Container API, and `container-process.ts` the lifecycle of the runtime's own container processes. Browser,
control-plane, and Agent code import the protocol instead of reaching into that implementation.

Tool-call arguments stream to the browser as the model produces them. `exec` additionally streams bounded transient
stdout/stderr updates while retaining only a bounded final tail for the model; completion still waits for the Container's
filesystem pull to become durable. The workspace's limits (files, total bytes, bytes per file) bound what reads the
project whole (state, sync, checkpoints, validation, saves), but a command writes straight to the container, so one can
leave the project over them: its result then tells the model what is over and how to get back within them, and the
workspace's state, deletions, and the container check before the cleanup command read metadata or stream instead, so
such a workspace can always be recovered (`user-workspace-runtime/src/workspace-inventory.ts`). Installed and built
output (`node_modules`, `.venv`, build directories) is left out of the project's record and does not count. The Pi loop enforces a total turn limit, a model-stream inactivity limit, and a first-progress
deadline against a hung provider stream; there is no model-step ceiling. Each tool has a deadline against a hung
operation, and a tool stopped by it is an ordinary failed result the model acts on, not the end of the turn. A tool that
completes as its deadline passes reports what it did; one that has not settled a minute after being stopped ends its
call with an outcome reported as unknown, since the turn's inactivity watchdog is paused while a tool runs. A cancellation requested before a Container process handle exists is retained and applied
as soon as that handle becomes available. `pnpm add <packages>` and `pnpm install --lockfile-only` route to the reviewed
dependency installer, which resolves npm registry packages with install scripts off and writes back only package.json
and the lockfile; any other install that names a package must name one from the npm registry. The model decides when to run the full
validation and what to tell the user; the runtime neither validates on its behalf nor writes its final message.
Production deployment is not a model capability: when a turn that changed a CloudChef app finishes, `ConversationAgent`
admits a durable deployment fiber that runs one authenticated, idempotent server operation. It builds the exact revision it was asked for (reusing a validation of that revision when the model
already ran one), prepares the exact-revision plan, and executes it in the user's account. A failed build or
deployment is shown to the user and told to the model at the start of its next turn. The browser can request a retry but is not responsible for starting deployment.
A turn that changes the app, however it ends, durably records that production must catch up (`publicationPending`),
and only production serving the current revision (`productionRevision`) clears it, so a publication cut short is
redone: at the next turn's end, even one that changed nothing, when that turn is stopped or fails before it
streams, and when a restarted agent starts. A message refused before its turn begins stops nothing. No automatic
publication starts while a turn runs, since it holds the workspace's operation lane. The person's next message stops
the deployment in flight until just before its migrations and upload (past that it finishes, since stopping would
leave production half changed). A deployment that
failed for a reason that passes (a busy workspace, another deployment of the project, an interruption, an unreachable
credential broker) is retried after 30 seconds, 2 minutes, and 8 minutes, and so is one whose failed record in the
user's account cannot be settled yet before it is redone; a failed build waits for the next turn. A
project deploys one revision at a time; a person's projects deploy independently. Validation and deployment use
checkpoints from the same VFS, so a publication never ships a revision other than the one it was asked for.

## Site Boundary

A CloudChef app has one site: its production Worker at its `workers.dev` address, with the project's D1 databases, R2
bucket, and KV namespace. There is no separate preview deployment; the chat's preview pane frames that production
site, which every project's `application-response.ts` lets cloudchef.build (and only it) frame. Full validation
copies the project to an isolated root, installs dependencies, runs typecheck/lint/stack verification, performs the
production build and `cf deploy --prebuilt` dry run against a trusted `worker.config.json`, and retains the
deployable module/asset/migration artifact under the content revision. The exact revision is asserted before and
after validation and again before publication. The Worker serves no versioned preview URLs (`previews_enabled` is
off), so no earlier version stays reachable against the data it was published with.

Production consumes the retained artifact for the same source digest, substitutes production bindings, uploads an
immutable version, and promotes that exact version. If Computer recycled after validation, artifact preparation
may rebuild from the retained source checkpoint, but its byte inventory must match the durable validation digest.

## Deployment Boundary

Deployment state and resource intent are recorded in the user workspace D1. Execution verifies that Computer's current
content checkpoint still matches the validated revision, reuses the revision-keyed validation artifact, provisions the
requested resources through the user's Cloudflare API authorization, applies migrations, uploads an immutable Worker
version, and promotes that exact version. CloudChef stores no deployment archive outside the user-owned runtime's
recoverable artifact cache.

The deployment executor derives resource names and security-sensitive configuration on the server. It records managed
Worker intent before publishing, then reads back the deployed version, script etag, bindings, variables, and schedules.
Ambiguous publish outcomes remain visible for owner review rather than being silently discarded. Once the version is
promoted, production serves it, so the deployment is recorded as succeeded whatever follows: a later step (the
schedule, the `workers.dev` address, its records) that fails twice becomes a warning the model and the person see, and
the next deployment repeats it. The execution records a receipt of the promoted version and retries the success write
a few times; if it still can't land, the record stays deploying, never failed, and a retry's recovery of the
interrupted record reads the receipt as its success.

A record left provisioning or deploying holds the project's one deployment slot, which otherwise only a deployment of
its own revision settles. Two settles keep a project that moved on deployable. The ConversationAgent settles a record a few
seconds after its fiber throws, whatever revision the project is at, unless a fiber of that revision runs again. A
deployment the slot refuses settles the record holding it (another revision's, or its own revision's under an earlier
id) once no fiber of the agent deploys that revision and the record has shown no work (an update or a recorded step)
for 15 minutes, since a deployment started through the runtime's deployment route runs outside the agent; it then
tries once more, unless it settled its own revision's record as succeeded, which production then serves. Each settles
as recovery of an interrupted record does: succeeded when its receipt says production serves it, failed otherwise.
Each settles only the execution it saw (the one that threw, or the one holding the slot): the write matches its
execution generation, so a later execution runs on, and a settle that waited to be admitted looks again for a fiber of
the revision before writing. Only a settle that itself settled the record as succeeded records production as serving
its revision; a record it finds already succeeded was settled by a later execution, which a later deployment may have
replaced.

A CloudChef app's account resources (its Worker and so its `workers.dev` address, `DB`, `AGENT_SECURITY_DB`,
`APP_STORAGE`, and `APP_CACHE`) belong to the project, the `ProjectWorkspace` a chat
builds in, not to a revision: every deployment replaces the Worker's version in place and keeps the data. A chat is one
project: its workspace is keyed on the chat (by the id of its first conversation's agent), and a new conversation (a
subchat) is a new agent with a fresh context working in that same workspace, publishing onto the same Worker and
resources and committing to the same repository. Only the newest conversation may change the project; the earlier ones
are kept to read, and the one before stops and hands its publication state to the new one when it starts. A deployment
id is only the record and idempotency key of one revision's publication. A plan names every resource after the project's own
identity (`appResourceIdentity`), and must name the Worker. A stored plan is not
replayed once the revision would get another (the Cloudflare connection, or the plan a release makes, changed since
it was made): the revision is planned again under the next of its deterministic ids, and recovery terminalizes each
of them, reporting the one it settled as succeeded, since production serves it. Each database keeps a receipt (name,
digest, and the SQL, which receipts written before it kept do not have) of every migration it applied: a deployment applies only the ones it lacks, and
refuses before applying any when one it applied has changed, telling the model to make the change in a new migration
and restore the applied one, quoting its applied SQL when the receipt has it. Generated-app migrations, the template's
included, are therefore append-only.

Deleting a chat releases its deployments oldest first. A deployment leaves a resource that a deployment released after
it also records or names, so a project's shared resources are deleted once, by the last of its deployments.

The workspace Worker never stores the user's OAuth access token as a binding. At deployment time it exchanges its
derived, generation-specific runtime secret at the control plane for a freshly resolved token. The broker rechecks the
active user, connection, generation, and credential handle; returns `Cache-Control: no-store`; and never follows an
alternate origin. Production pins that broker to `https://cloudchef.build` in
`user-workspace-runtime-policy.ts`. An open-source fork must change that constant to its own HTTPS control-plane origin,
regenerate the user runtime, and re-provision existing user runtimes. Redirecting the configured endpoint is
intentionally unsupported because it would disclose the runtime secret.

## Generated-Application Boundary

`template/` is an independent application. Its default is a framework-free Worker web app (Vite, an `index.html`
client, and the project-owned `src/application.ts` handler, reached through a Worker-first `ASSETS` binding so the
security headers cover every page) with no Workers AI
binding, Agent Durable Object, Agent security D1, cleanup cron, or Agent/AI packages. A project that needs durable AI
runs `pnpm run agent:enable`; the command applies the reviewed capability manifest, installs its dependencies at
their latest release, switches the Worker entrypoint to the protected `src/server.ts` the template already ships
(removing it and the Agent modules from `tsconfig.json`'s excludes), and adds the Agent security database, Durable
Object export, and cleanup schedule together (`template/agent-capability.json`).
Partial Agent configuration fails validation. When enabled, application data stays in `DB`, while Agent sessions,
retention state, and inference accounting stay in separately provisioned `AGENT_SECURITY_DB`. Only the AppAgent
runtime may import that binding; the protected build policy checks the resolved module graph so aliases and
dependencies cannot widen the capability boundary. Once published, the capability stays: Cloudflare removes a
Durable Object class only by deleting it with every object and its data (an export in the `deleted` state, or a
`deleted_classes` migration, as wrangler's own export schema and migrations model it), and CloudChef never sends
either. A deployment without the capability to a Worker for which Cloudflare holds an `AppAgent` namespace is
therefore refused before it changes anything, telling the model to restore it. What Cloudflare does with a version that merely omits a
class it holds was not confirmed (no local documentation says), so CloudChef does not rely on it either way. The policy is structural rather than pinned to package versions:
only the Agent packages (and capnweb, their RPC layer) may import `cloudflare:workers`, only the protected
entrypoints and those packages may import the Agent runtime, and project code may reach `globalThis`, `self`, or
`window` only through property access, because capnweb keeps the Workers module on the global object under an
unregistered symbol that enumeration would expose. A web framework is the project's own choice: the builder adds one
only when the product needs it, and wires its handler into `src/application.ts` behind the same entrypoints.

Root dependencies do not implicitly apply to the template, and a template change is complete only when standalone
verification passes (generation is in DEVELOPMENT.md, Generated Artifacts). Generated-project package-manager constraints live in
`template/scripts/lib/project-policy/generated-project-dependency-policy.json`; browser admission and repository/template
verification consume that same data rather than maintaining separate security override lists.

## Cloudflare Computer Dependency

CloudChef pins `@cloudflare/computer` to `0.8.0`, exactly, and computerd to the same release (The container scheduling
policy, The base snapshot). Computer calls its
filesystem and tools stable, and its container backends, the sync protocol and computerd experimental; CloudChef depends
on all three, so every upgrade is an architecture review. `cloudchef-agent/cloudflare-computer.test.ts` pins the
declared and installed version (with no release-age exemption), canaries both hunks of the local patch
(`patches/@cloudflare__computer@0.8.0.patch`: 0.8.0 still probes 100 blob hashes per statement and still issues raw
`SAVEPOINT` for a nested transaction, which a Durable Object refuses) against the published bundle so a reflowed
upstream region fails rather than silently unpatching, pins the file-tool limits, and pins the error shapes that cross
Workers RPC (pending-sync and operation-lane conflict). The limits are enforced by CloudChef's own tools: 10,000 lines
or 1 MiB per read and 2 MiB per write or edit (the Durable Object SQLite value limit); separately, the runtime keeps a
256 KiB tail of each exec output stream for the model (`user-workspace-runtime/src/index.ts`). The Workspace runs
with `output: false`: Computer's own 2,000-line, 64 KiB cut would save every long output as a file inside the durable
VFS.

Computer 0.3 removed the durable post-command sync retry contract the workspace's correctness rests on, so it is
CloudChef's code (`user-workspace-runtime/src/workspace-sync-retry.ts`): one intent per backend in the Durable Object's
SQLite (the table predates the move, so intents written under 0.2 carry over), naming the container runtime that ran
the command; backoff from 1 second doubling to 60, five attempts, then exhaustion and recovery through a fresh
connection. Every retry checks the runtime before and after its pull, because Computer reconnects a dropped backend
inside a pull: a pull from any other runtime is `lost`, which fails the command instead of reporting changes that never
reached the VFS as saved. A non-streamed command uses Computer's own post-command pull, which refuses another runtime
and reports itself pending; a streamed one cannot report it, so the runtime confirms it with a pull of its own.
`Workspace.pull()` and `push()` are async iterables of blocks since 0.3, drained to completion.

CloudChef no longer depends on `@cloudflare/sandbox`: Sandbox 1.0 had removed the `Sandbox` class, its process API,
its scheduler and its terminal, and what it left, file reads and writes through its `sandbox-shim` binary, is a few
commands on the Container API (`mkdir`, a write beside the file renamed over it, `stat` and `cat`), so neither the
package nor the binary is in the container. `ProjectWorkspace` and `ProjectBuilder` are plain Durable Objects on the
Container API (`computer-sandbox.ts`, `project-builder.ts`): the runtime's own commands and file transfers run beside
computerd through `ctx.container.exec`, under GNU `timeout` as process-group leaders (`container-process.ts`), with only the
environment the runtime passes (`CONTAINER_COMMAND_ENV`; exec inherits nothing but `PATH`); scheduled callbacks are rows
in each object's SQLite run from its alarm (`scheduled-callbacks.ts`); the idle window is
`ctx.container.setInactivityTimeout` (10 minutes, an hour while a deployment holds its artifact, 15 minutes for the
builder); and the person's terminal is a tmux client on a pseudo-terminal (`workspace-terminal.ts`), bridged to the
browser's WebSocket, which reattaches to the container's one shell session. The bridge also speaks enough of Sandbox
0.x's terminal frames that a page loaded before an upgrade keeps working, and the page reads both.

computerd passes its commands only `PATH`, `HOME`, `TMPDIR`, `TZ`, `LANG`, `TERM`, `LC_*`, and `COMPUTER_VAR_`-prefixed
variables (unprefixed), so the command environment is passed that way, and `RPC_CLIENT_SECRET`, a random secret per
workspace the container host keeps in that Durable Object's storage and adds only to the container's start environment,
never reaches a command; CloudChef never logs it.

### The container scheduling policy

Every runtime's two container applications (`<worker>` for `ProjectWorkspace`, `<worker>-builder` for `ProjectBuilder`)
use the `durable_object` scheduling policy, and the Worker upload names no image (`containers: [{ class_name }]`, no
`images`). Each Durable Object starts its own container with `ctx.container.start()`: at `standard-4`
(`PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE`, asked for at each start; the application carries no instance type and,
under this policy, no instance limit), with internet access (`enableInternet: true`), and from either Cloudflare's
managed image `cloudflare/debian-trixie` (Node 24 on Debian trixie slim, offered only under this policy) or the
runtime's base snapshot of it. Nothing of CloudChef's is published to any registry. The workspace runs Computer's
`ContainerBackend` (`@cloudflare/computer/backends/container`) through a host of CloudChef's own
(`ManagedWorkspaceContainerHost` in `computer-sandbox.ts`), because Computer's own host starts only images the Worker
upload names in `ctx.container.images`, and the managed image is not one. The host keeps computerd's
`RPC_CLIENT_SECRET` in the Durable Object's storage, adopts a running container only when it was launched with the
same environment and computerd was told to start, and records an exit the platform reports.

Outbound interception is the Container API's own (`ctx.container.interceptOutboundHttp`) under either policy: each
launch intercepts Computer's egress host, `git.internal` (the GitProxy) and `cloudflare-api.internal` (the
CloudflareApiProxy) for the workspace, and `git.internal` and the deploy proxy's `cloudflare-api.internal` for the
builder, while everything else goes to the internet directly.

#### The base snapshot

The managed image carries none of what CloudChef needs, so a container's first start sets it up
(`user-workspace-runtime/src/base-container.ts`). The entrypoint waits for a marker file, so nothing of CloudChef's
runs while the setup does. The setup script installs, with apt, `fuse3` (computerd dlopens libfuse 3.17 for a real
FUSE mount and falls back to its userspace shim without `/dev/fuse`, `FUSE_MOUNT=auto`), `git`, `tmux`, and the
coreutils, findutils, procps, util-linux and passwd tools the runtime's and the builder's own commands use; it
replaces the image's Node 24 with Node at `.nvmrc`'s version (the linux-x64 tarball, checked against its SHA-256);
it installs pnpm and the credential-free cf CLI at the generated projects' pins with npm; and it downloads computerd
0.8.0 from GHCR as the image's single layer, by that layer's digest, checked against it. It writes `/etc/tmux.conf`,
empties `/home` (computerd's mount point, where the image keeps its `node` user's home) and records the key it is
named by. Its pins are checked against `.nvmrc`, package.json and the template by `pnpm run verify:stack`
(`findWorkspaceBasePinErrors`) and the base-container tests, and against what nodejs.org and GHCR serve by the daily
`runtime-artifacts` workflow (`scripts/check-runtime-artifacts.mjs`).

After the first successful setup the start takes a snapshot of the whole filesystem (`ctx.container.snapshotContainer`)
before computerd starts, so nothing of a person's is in it, and keeps its handle in the runtime's D1
(`base_container_snapshots`, `user-workspace-migrations/0023_base_container_snapshots.sql`), where the workspace and
the builder Durable Objects of the runtime both read it. Its key names everything it depends on: the managed image and
a digest of the setup script, which spells out every pin. Every later start of the runtime, of any workspace or of the
builder, restores the snapshot whose key matches (`ctx.container.start({ containerSnapshot })`), checks that the
container records that key, and only then lets computerd start. A start that finds no snapshot for its key, one not
refreshed for 29 days (Cloudflare keeps one 30 days from when it was taken or last restored, and each restore starts
them over), one Cloudflare refuses to restore, or one that does not record its key, sets up from the managed image
instead and forgets the one that failed. Only one start at a time may take a snapshot for a key: it claims the right
in D1 first (`setup_holder`, lapsing after 15 minutes), and any start that loses the claim sets up for itself and
takes no snapshot. A release that changes the setup or a pin has a new key, so each runtime sets up once more and the
new snapshot replaces the old row.

What the runtime writes at each start (the git wrapper and its hooks, the cf launcher and the `cloudchef` command,
`container-toolchain.ts`) runs after the restore, never into the snapshot, so it changes with the runtime and not with
the base. A first setup is expected to take two to four minutes (apt, a 30 MB Node tarball, npm installs of pnpm and
cf, a 43 MB computerd layer) and is bounded at 10 minutes; a restore takes about as long as any container start. The
workspace connect budget (`CONTAINER_CONNECT_TIMEOUT_MS`) covers a first setup, the toolchain bootstrap and computerd's
connect stages.

The base snapshot is per runtime, not per Cloudflare account: a person's own account has one runtime, but each member
of a team has their own runtime in the team's account, and each takes its own base snapshot once. A store every
member's runtime can read would need a binding none has today, and restoring a snapshot taken by another Worker's
Durable Object is not something the documentation states.

Each start restores the same base, so programs a person installs outside their project are gone once the workspace
sleeps after 10 minutes unused, as the terminal's tip says. A follow-up could keep them: a per-workspace snapshot taken
as the container goes idle and restored at its next start, with its own 30-day lifetime and its own key.

#### Moving a runtime from the default policy

Runtimes provisioned before this release have platform-scheduled applications (`scheduling_policy: "default"`, the
image in the application). Cloudflare fixes an application's policy when it creates it, so the upgrade replaces each
one: `ensureWorkspaceRuntimeContainer` lists the account's applications, refuses one of the same name that serves
another Durable Object namespace, leaves one already on `durable_object` alone, and otherwise deletes the
application and creates it again with `scheduling_policy: "durable_object"` and the same name and namespace. The
Durable Object namespaces belong to the Worker, not the application, so their storage is untouched: project files
(Computer's VFS), the change index, the tool journal, validation receipts and pending-sync intents are in each
Durable Object's SQLite, and computerd only syncs the container's `/home` with it. The upgrade runs in this order,
each step inside the runtime's upgrade window, which is granted only while no turn, validation, publish, approved
Cloudflare request, GitHub build watch or seeding runs, nor has for two minutes:

1. The Workflow claims the window and redeploys the Worker with this release's runtime. From here the new code starts
   containers only under `durable_object`, so a container start in this gap fails until step 3 (nothing should start
   one: the window holds new work back).
2. It configures the Worker (schedule, subdomain).
3. It replaces the workspace application, then the builder application. Deleting an application ends its running
   containers at once: a workspace container still inside its 10-minute idle window, and whatever runs in it that no
   turn records, such as a command typed in the terminal, ends there and then. A model command cannot be running, since
   its turn would hold the window back; one whose post-command pull had not landed keeps its pending-sync intent in
   SQLite, and its retry reports a pull from the replacement container as lost rather than as saved, as for any
   replaced container. Files the container wrote outside `/home` (installed programs, the pnpm store) go with it, as
   they do when it sleeps.
4. It waits for the new runtime to be ready, releases the window and records the runtime with its container identity
   (`cloudflare/debian-trixie (durable_object)`).

The next start of each workspace is a fresh container: the runtime's first one sets up and takes the base snapshot,
the others restore it. A retried step finds an application already deleted gone, or deletes one Cloudflare had not
finished deleting again, and creates it.

The scheduled sweep and session requests start this upgrade as they start any other, and
`WORKSPACE_RUNTIME_UPGRADE_CANARY` holds it to the named runtimes, so the owner's runtime moves first while everyone
else's keeps serving from its platform-scheduled applications. A first workspace is created on `durable_object`
directly.

#### Rolling back

A release from before this one cannot start containers under `durable_object`: its Worker names no image at
`start()`, and its provisioning, finding an application of the right name and namespace, sends it a configuration with
an image and `scheduling_policy: "default"`, which Cloudflare is expected to refuse, the policy being immutable.
Rolling back a moved runtime is therefore two things: deploy the earlier release, and delete the runtime's two
`durable_object` applications (`cf containers applications delete <id>`, an application's id being its namespace's under
this policy, as Wrangler expects) while the runtime is idle. The earlier release's provisioning, whose
container step is retried with backoff and whose failed-after-redeploy upgrades every sweep restarts, then finds no
application and creates the platform-scheduled one with its own image. Workspace files are in the Durable Objects and
survive both directions; the base snapshot row stays in D1, unused, until a release with its key runs again.

## Model Context and Prefix Caching

The browser sends open, recently used, and locally modified file context with each message. It goes into what the model
is sent for that message (`app/lib/.server/llm/turn-context.ts`), marked as data, and so into the transcript as the model
saw it; the chat shows only the person's text. The system prompt is one section describing the environment
(`cloudchef-agent/prompts/system.ts`, with the skills catalog from `builder-skills.ts`), fixed for a conversation.

There is no compaction and no history tool: a context fills the model's window, and prompt caching covers the cost of
the long prefix. Near the window's limit the builder hands off (`app/lib/.server/llm/handoff.ts`): the model is asked,
after the conversation so far, for a note for whoever continues; the conversation is reset to that note
(`Conversation.reset`); and the person's latest request is sent again, so the work goes on in a fresh context that starts
from the system prompt, the note and that request, without the person doing anything. The threshold is pi-durable's own
accounting: the newest response's reported usage and what came after it, against the window less what pi keeps for the
answer (and, at a turn's start, a margin so the turn has room). A run hands off after a round of tool calls that passed
it, a turn starts by handing off when it begins past it, and a provider's context overflow hands off and sends the
request again once. The chat shows the note where the conversation went on from it, closed, and everything before it.

pi-durable sends each request with the conversation's own provider session id (`pi.provider`), which survives restarts
and handoffs, as Workers AI's session affinity and providers' prompt-cache key, at pi's default cache retention. Claude's
signed thinking is kept in the transcript and sent back verbatim; a request Claude refuses for a thinking signature is
sent once more without thinking (`createGatewayFetch` in `pi-ai-models.ts`). Each response's token counts are logged,
cache hits included, and reported for the organization's per-member usage. The evidence on cache savings is in
`docs/DECISIONS.md`.

pi-durable bounds each model request (its stream timeout and retries); the agent keeps only a turn's overall time limit
and a watch for a run that shows no progress between its tool calls (`builder-turn-limits.ts`).

## Trust Boundaries

User input, generated code, model output, and repository context are untrusted. Secrets remain in server-side
Cloudflare bindings; generated-project actions reject secret files. Generated code never executes in the CloudChef
control-plane Worker. Runtime capabilities are short-lived and bound to the authenticated user and browser origin.
A member's chats, transcripts, and project files live in their organization's Cloudflare account, where its
administrators and account holders can read them; the product says so when someone accepts an invite.
