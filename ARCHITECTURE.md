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
`BuilderAgent` Durable Objects, and a `ProjectWorkspace` Durable Object backed by a Cloudflare Container in that user's
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
`BuilderAgent` records in the runtime's D1 (`runtime_activity`) whether it is working, and for two minutes after it
stops. Its turn (and the validation it runs) counts from its state; a production publication, an
approved Cloudflare request, a GitHub build watch, and seeding a new workspace count while their work actually runs
(`BuilderRuntimeActivity.run` in `app/agents/builder-runtime-activity.ts`), never from the deployment
record in state, which an editor save rewrites while that work continues. Before redeploying,
the Workflow asks the runtime, with its secret, for the upgrade window (`POST /v1/upgrade-window`): one statement
grants it only when no row is active. It then redeploys the Worker, configures it, rolls out the container image,
and waits for the new runtime to be ready, renewing the window on the new runtime (`PUT`) throughout, and releases
it (`DELETE`) once the runtime serves; the rollout replaces running containers at once, so nothing may start before
it completes. Each of these is its own Workflow step, so a retry never claims the window again or redeploys. Each
call names the Workflow instance holding the window (a `cloudchef-upgrade-holder` header, which every call must
carry): another upgrade's claim or renewal is refused while it is open, as for a busy workspace, and only its holder
releases it. The holder's
own claim of its window still open is granted whatever is busy, so a retried deploy step (which may find the Worker
it already redeployed) keeps the window rather than letting it lapse under work waiting for it. Work
that starts records itself first and then waits while any window is open, on the old Worker or the new one; a
window lapses five minutes after its last renewal, which bounds the wait when an upgrade stops partway. A turn
waits at most three minutes, then asks to be sent again; a Stop calls its wait off. A step's retries can outlast
the window, so the runtime renews a lapsed window only while nothing is busy (`409` otherwise): work that started
meanwhile would be cut off by the rollout, and the Workflow waits for it as for a busy workspace, without
redeploying again. Work that cannot record itself or read the window retries for a minute before it starts anyway.
A busy workspace is asked again with backoff (30 seconds doubling to 5 minutes); after 12 hours the Workflow ends without upgrading, and the
next session request, or the next sweep, starts another. That limit applies only before the redeploy: once the new
Worker serves, the steps after it wait, with the same backoff, for as long as work keeps them from the window, since
that Worker still needs its container image, its schedule and its readiness check. A Workflow restarted partway
claims the window again and redeploys only once the workspace is idle, so it never cuts work off.

A runtime whose owner does not come back would otherwise stay on an old release, and a failed upgrade would stay
failed until the browser's explicit retry. The control plane's 15-minute cron therefore also sweeps
(`app/lib/.server/cloudflare/user-workspace-runtime-upgrade-sweep.ts`): it lists ready runtimes that are outdated but
still serve their connection's generation and protocol, all of them, most recently used first, skips anyone who may
no longer use the connection, and starts or restarts the same gated Workflow instance a session request would name,
until it has launched 10 (`UPGRADE_SWEEP_MAX_LAUNCHES`); upgrades still waiting don't count toward that cap, so they
never keep a sweep from the rest. An upgrade still waiting is left alone; one that gave up waiting is restarted; one that failed is
restarted on one sweep in four, so at most hourly, unless it failed after redeploying the Worker (which then serves
without its container image or schedule), which every sweep restarts. First-time provisioning never goes through the sweep: it lists only
runtimes that are already ready. A busy row a Durable Object never cleared stops counting after the turn wall clock
plus 30 minutes.

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
each time it is admitted, whether the agent's direct `cloudflare_request` tool is offered, which only the
organization's active admins get, so a demoted admin loses it at once.
The same answer carries the person's own AI Gateway content-logging choice (`user.ai_gateway_content_logging`,
set in Settings), which the runtime asks for before every builder turn, title, and prompt enhancement in any
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
direct `cloudflare_request` tool in a shared account (above). A member's changes go through the deployment pipeline
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
changes go to their own branch (`cloudchef/<member>-<key>`, `app/lib/member-branch.ts`), and publishing merges it
into `main`.

CloudChef never builds or deploys a project kept in Artifacts. Workers Builds, connected to the repository,
deploys `main` (the only production branch Artifacts supports) and builds other branches into Previews. The
control plane reads what it reports with the connection's own authorization (`workers-ci.read`), never handing
a team's token to a member (`app/lib/.server/cloudflare/workers-builds.ts`): the project's Worker is found by the
repository its latest build came from (its Artifacts repository, or the GitHub one it was imported from, until
its builds are switched) and remembered (`workers_builds_script_tag`); `/runtime-projects/status` matches a
commit to its build, and `/runtime-projects/site` reports the Worker's production and Preview origins, which each
turn's context names so the agent can read the live site with `curl`. Workers Builds' API names no Artifacts provider for a repository
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
deleting main or pushing anything but branches and tags, and records the refs a push updated. A CloudChef app's
production serves main: a turn that pushed main publishes it, with its exact-revision deployment, and only while the
workspace holds exactly what main does. `revertToCommit` applies an earlier commit's files as one compare-and-swap
change set (refused while a turn runs), commits them as `Revert to <short commit>`, and the ordinary publication
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
| Agent messages, turn state, compaction, and resumable execution                                   | User-owned `BuilderAgent` DO SQLite                  |
| Project bytes, numeric revision, change index, tool journal, and validation receipts              | User-owned `ProjectWorkspace` Computer VFS/DO SQLite |
| Dependency installation, validation, and deployable artifact preparation                          | User-owned `ProjectWorkspace` Container backend      |
| Production-version upload and promotion                                                           | User's Cloudflare account APIs                       |
| Query collections and editor files                                                                | Rebuildable in-memory browser presentation cache     |
| Generated application's Worker, D1, R2, Agent, and related resources                              | User's Cloudflare account                            |

Do not create a second authoritative store for the same state. Browser and process-local materializations must be
rebuildable from their owner. Cloudflare Computer's SQLite VFS in `ProjectWorkspace` is the sole authority for project
files; the browser editor and container mount are replicas of that state.

## Transcript Reconciliation

`BuilderAgent` DO SQLite is the only authoritative message transcript and checkpoint store. Generation, reload,
interrupted-turn recovery, and context compaction all read that Agent. User workspace D1 stores only routing and catalog
facts: the Agent name, subchat index, branch ancestry, and whether the chat has accepted content. It stores
no message positions, counts, digests, or browser-authored checkpoint. The browser's TanStack collection is a
rebuildable in-memory view.

Reconciliation is deterministic:

1. Reload resolves the owner-scoped transcript identity from D1 and asks that exact `BuilderAgent` for its checkpoint
   and messages. A mismatched Agent identity is a conflict, never a fallback to another history.
2. Before send, the browser asks the Agent for its current checkpoint and compares it with the complete local view. A
   mismatch blocks the send and requires a reload. The checkpoint rides with the message only as transient base
   metadata, so the Agent rejects a stale client that races after the preflight; it is stripped before persistence.
3. Once the Agent accepts the first user content, it marks the chat visible in D1 using its bound identity. This writes
   one catalog boolean, not a transcript projection. D1 never receives the message body or checkpoint hash.
4. A subchat records its parent subchat and revision. The runtime reads that revision directly from the
   parent Agent before the D1 transition, then uses a unique token to recognize an exact commit whose acknowledgement
   was lost.

## Project Lifecycle

`BuilderAgent` owns conversation execution and delegates project operations to `ProjectWorkspace`. Cloudflare Computer
stores files directly in the Durable Object's SQLite VFS. Its container backend projects the same files into the
Container through FUSE and reconciles changes back to the VFS.

The model receives seven workspace primitives (`cloudchef-agent/model-tool-inputs.ts`,
`app/lib/.server/llm/workers-ai-tools.ts`), split by what they cost. `read`, `ls`, and `grep` are answered from the
Durable Object's SQLite VFS alone — no container, no sync barrier, and never the exclusive workspace operation lane, so
discovery answers before the container is warm and stays available while a build command holds the lane. `write`,
`edit`, `exec`, and `validate` change the project or run in its Container under that lane. All seven are CloudChef's
own: `read` returns a file's text from a line offset, `edit` replaces exact text that occurs once (or every occurrence
when asked), `write` honours the turn's abort signal, `exec` streams its output and runs what it is asked except a
command that touches CloudChef's platform processes and state or asks `cf` for a credential
(`cloudchef-agent/workspace-boundary.ts`), and `validate` runs the project's full validation. `@cloudflare/computer/tools` contributes only
types.

`ls` enumerates a directory or the tree beneath it and `grep` returns path, 1-based line, and matching line for a
literal pattern. Line numbers come from the same splitter `read` uses, so a search hit names the line a read
prints. `grep` matches literal single-line text and never compiles the model's pattern into a
regular expression or a shell command: an untrusted pattern must not be able to backtrack the Durable Object into a
stall or inject into the container. Both tools are bounded in the spirit of Computer's reviewed read and exec limits —
`user-workspace-runtime/src/workspace-discovery.ts` names every ceiling and the failure it prevents — and both report
`truncated` so the model narrows the path or the pattern instead of paging blindly. A recursive walk shows
`node_modules` and build output but does not descend into them, unless one of them is the requested path; that is how
the model still reads the framework version the project installed.
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
artifact, project files cannot shadow it, and it never appears in `ls` or `grep`, which are asked only about the
project. The system prompt (`cloudchef-agent/prompts/system.ts`) describes only the environment — the workspace and
its tools, the kind of project (a CloudChef app, or a team's GitHub project, whose catalog omits project-stack), and
how changes are published — and leaves to the model what it can decide itself; concrete product and API guidance
comes from retrieval, while code and deployment boundaries remain enforced by project validation. A documentation search that fails returns a failed tool result the model can
act on, rather than ending the turn.

Cloudflare account work goes through Cloudflare's `cf` CLI and one Worker-side tool. The container's `cf` launcher
installs the pinned CLI on first use; the model finds an operation with `cf cli search`, checks it with `cf schema`,
and prints the exact request with `--dry-run`. The container holds no Cloudflare credential, so `cf` only plans. The
model passes the dry-run JSON to `cloudflare_request`, which the runtime Worker validates (the public v4 API only, and
only the connected account) and sends with a fresh access token from the credential broker. GET requests run
immediately. Every other method is stored as a durable, expiring proposal bound to the account, connection, transcript,
and exact request digest; it pauses the turn until the owner approves or rejects it, and an interrupted approved
request is marked indeterminate rather than replayed.

Model tools and editor reads use the same workspace API. Browser saves use
compare-and-swap against the numeric revision the browser loaded; a conflict refreshes from the user runtime and never
overwrites newer state. TanStack DB collections are in-memory presentation caches rebuilt from the user runtime. The
browser has no second SQLite or OPFS copy of chats, transcripts, or workspace files.

The user workspace is a separate workspace package, `@cloudchef/user-workspace-runtime`. Its `./protocol` export is
the only shared source for sync limits, request/result types, and readiness contracts. The runtime owns
the `ProjectWorkspace` implementation; `computer-sandbox.ts` contains the Cloudflare Computer/Sandbox adapter and
container-process lifecycle. Browser, control-plane, and Agent code import the protocol instead of reaching into that
implementation.

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
Production deployment is not a model capability: when a turn that changed a CloudChef app finishes, `BuilderAgent`
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
its own revision settles. Two settles keep a project that moved on deployable. The BuilderAgent settles a record a few
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

CloudChef intentionally pins `@cloudflare/computer` to `0.2.1`. Cloudflare labels this release preview-only, describes
its API as unstable, and says it is not suitable for production use. The repository therefore treats every upgrade as
an architecture review. `cloudchef-agent/cloudflare-computer.test.ts` pins the declared and installed version (with
no release-age exemption), canaries both hunks of the local patch (`patches/@cloudflare__computer@0.2.1.patch`)
against the published bundle so a reflowed upstream region fails rather than silently unpatching, pins the file-tool
limits, and pins the error shapes that cross Workers RPC (pending-sync and operation-lane conflict). The limits are
enforced by CloudChef's own tools: 10,000 lines or 1 MiB per read and 2 MiB per write or edit (the Durable Object
SQLite value limit); separately, the runtime keeps a 256 KiB tail of each exec output stream for the model
(`user-workspace-runtime/src/index.ts`). These gates detect drift; they cannot turn a preview dependency into a
stable production contract.

Computer 0.6 and Sandbox 1.0 are one migration, not two version bumps, so both stay pinned until it is done. Computer
0.3 removed the durable post-command sync retry contract the workspace's correctness rests on (`SyncRetryScheduler`,
`retryPendingSync`, and its `lost` and `exhausted` outcomes): a pending pull is now only reported, and retrying it, and
refusing to pull from a container that did not run the command, become CloudChef's code. Computer 0.4 also deprecated the
platform-scheduled container backend CloudChef uses for `ContainerBackend`, which starts the container from the
Durable Object through `ctx.container.images`. Sandbox 1.0 removes the `Sandbox` class and its process API for the same
Durable Object scheduling policy, and moving a container application to it cannot be rolled back. Both patch hunks are
still needed in Computer 0.6.0: it still probes 100 blob hashes per statement and still issues raw `SAVEPOINT` for a
nested transaction.

## Model Context and Prefix Caching

The browser sends open, recently used, and locally modified file context as a bounded turn attachment. The server adds
that attachment only to the current model view; it never persists the generated context as a transcript message.
`history` searches and pages the current authenticated conversation, including earlier context windows. When the
context reaches the rollover threshold, or a provider reports a context overflow, CloudChef starts a fresh window from
a bounded deterministic recovery record of the user inputs and the latest tool batch. No separate summarizer model is
called, and the model is not asked to hand off. The record is not a verified progress summary, and says so; history
holds the details. Repeated rollovers do not nest records. The complete transcript remains in the owning Agent; live history ids are turn-local, so after a
restart the builder searches again for durable message ids. Existing summary checkpoints remain readable, and anchor
validation prevents applying a checkpoint after a rewind removed its source. Thresholds follow the selected model's
window, including a smaller limit learned from the provider, with output and estimation headroom reserved.

Long before that threshold, old tool output is cleared from the model's view (`tool-result-clearing.ts`): once the
context passes 64k tokens (or half the input budget of a smaller model), every large tool result except the six most
recent is replaced by a fixed note, keeping each message and tool call in place, and only when that frees at least 12k
tokens. Clearing is rare and step-wise, and the note is byte-identical each time, so the cached prefix holds up to the
first newly cleared result. The transcript and `history` keep the original output.

The builder loop stays on Pi rather than AI SDK's `ToolLoopAgent`, which has no equivalent of Pi's steering queue; the
review is in `docs/DECISIONS.md`.

Workers AI prefix caching is automatic for supported models. CloudChef sends an opaque, stable session-affinity value
per transcript and model through the AI binding's `extraHeaders`, keeps system instructions at the front of the
prompt, and leaves dynamic project context in the latest user turn; finish telemetry reports Pi's `usage.cacheRead` as
hits or misses without logging prompt contents. The evidence on cache savings is in `docs/DECISIONS.md`.

## Trust Boundaries

User input, generated code, model output, and repository context are untrusted. Secrets remain in server-side
Cloudflare bindings; generated-project actions reject secret files. Generated code never executes in the CloudChef
control-plane Worker. Runtime capabilities are short-lived and bound to the authenticated user and browser origin.
A member's chats, transcripts, and project files live in their organization's Cloudflare account, where its
administrators and account holders can read them; the product says so when someone accepts an invite.
