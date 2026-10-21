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

It holds exactly one R2 bucket, and only for a build artifact CloudChef itself publishes: the OCI blobs of the user
workspace container image. Cloudflare's registry is account-scoped — repository names are `<account_id>/<image>`,
anonymous reads are refused on every path, and there is no shared namespace or server-side copy API — so the image has
to be pushed into each user's own registry by a client, and that client needs somewhere to read the bytes from. No
customer project data enters this bucket, and nothing in it is user-specific.

Opening a project after Cloudflare is connected queues a durable control-plane Workflow that provisions a workspace Worker, D1 database,
`BuilderAgent` Durable Objects, and a `ProjectWorkspace` Durable Object backed by a Cloudflare Container in that user's
account. Runtime-session requests return `workspace_preparing` while that Workflow runs, and the browser polls with
bounded backoff instead of holding the provisioning request open. Once ready, the browser receives a short-lived,
origin-bound capability and communicates directly with that Worker for chat, project, preview, and deployment
operations. Generated-application D1 and R2 resources are created later only when the validated deployment plan
requires them. Cloudflare meters those resources to the user's account.

## Runtime Upgrades

Redeploying a workspace Worker resets its Durable Objects, which ends whatever they are running. A CloudChef
release therefore never redeploys a runtime that is working. `USER_WORKSPACE_RUNTIME_SHA256` is the digest of the
runtime bundle itself, so a control-plane-only release leaves every runtime alone. When a runtime is from an earlier
release but serves the same connection generation and speaks the same `USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION`
(`user-workspace-runtime/src/protocol.ts`), the runtime-session request keeps issuing sessions for it and starts the
provisioning Workflow in the background; the browser shows no preparation. A missing runtime, one for an earlier
connection generation, or one speaking another protocol is prepared before a session is issued, as before. A
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
stops. Its turn (and the validation it runs) counts from its state; a preview or production publication, an
approved Cloudflare request, a GitHub build watch, and seeding a new workspace count while their work actually runs
(`BuilderRuntimeActivity.run` in `app/agents/builder-runtime-activity.ts`), never from the preview or deployment
records in state, which an editor save or a cancellation rewrites while that work continues. Before redeploying,
the Workflow asks the runtime, with its secret, for the upgrade window (`POST /v1/upgrade-window`): one statement
grants it only when no row is active. It then redeploys the Worker, configures it, rolls out the container image,
and waits for the new runtime to be ready, renewing the window on the new runtime (`PUT`) throughout, and releases
it (`DELETE`) once the runtime serves; the rollout replaces running containers at once, so nothing may start before
it completes. Each of these is its own Workflow step, so a retry never claims the window again or redeploys. Each
call names the Workflow instance holding the window (a `cloudchef-upgrade-holder` header, which a runtime from
before holders ignores): another upgrade's claim or renewal is refused while it is open, as for a busy workspace,
and only its holder releases it; a window claimed without a holder may be renewed or released by any. The holder's
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
still serve their connection's generation and protocol, most recently used first and a further page of them on each
sweep (so a page of upgrades all still waiting never keeps it from the rest), skips anyone who may no longer use
the connection, and starts or restarts the same gated Workflow instance a session request would name, at most 10
per sweep. An upgrade still waiting is left alone; one that gave up waiting is restarted; one that failed is
restarted on one sweep in four, so at most hourly, unless it failed after redeploying the Worker (which then serves
without its container image or schedule), which every sweep restarts. First-time provisioning never goes through the sweep: it lists only
runtimes that are already ready. A busy row a Durable Object never cleared stops counting after the turn wall clock
plus 30 minutes. A runtime from before the window existed cannot answer, so it is upgraded only once the control
plane has issued no session for it for that long, since a turn needs a session to start.

Because a deferred runtime keeps serving the current browser and control plane, runtime routes, callables, state, and
control-plane calls must stay compatible with the previous runtime, and user-workspace D1 migrations, applied before
the deferred redeploy, must be additive. A change the previous runtime cannot serve bumps the protocol version.

## Accounts, Organizations, and Contexts

A Cloudflare connection belongs to one person (their own account) or to an organization (its admins connect the
organization's account once). Sign-in is separate from connecting: Cloudflare, Google, or an emailed one-time link
creates a session, and a session works in one context, a connection the person may use, chosen with the workspace
switcher. People without Cloudflare logins of their own build in an organization's account.

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
48 MB; a runtime from before those headers names itself in the body, which is then read only up to 64 KB first. Each
secret may make 600 calls a minute (`RUNTIME_RATE_LIMITER`). In an organization's account the runtime also asks (`/api/cloudflare/runtime-access`) before
each model turn, since the model runs on the organization's Workers AI without a token from the broker.
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
time, whoever added them, and uses each provider's default key, or its first, under whatever alias it has. An
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

An organization's authorization reaches every workspace in its account, so in a shared account
(`CLOUDCHEF_SHARED_ACCOUNT`) the agent's direct `cloudflare_request` tool is offered only to the
organization's active admins, asked of the control plane (`/api/cloudflare/runtime-access`) each time it is
admitted, so a demoted admin loses it at once. A member's changes go through the deployment pipeline or GitHub,
which touch only their own resources.
A tab names the
account it opened in on each runtime-session request and reloads if another tab switched the session.

An organization keeps at least one active admin. Erasing a member's account never revokes the organization's
authorization; erasing its last member removes the organization and revokes it.

## GitHub Projects

An organization can work on existing apps kept in GitHub, which stays their source of truth. An admin installs
CloudChef's GitHub App on the account holding them, choosing its repositories, and links repositories as projects,
choosing which members may work on each (`app/server-handlers/github-projects.ts`,
`app/lib/cloudflare/data/org-projects.server.ts`). The installation is recorded only after the returning admin's own
GitHub authorization shows they control it: their own account, or a GitHub organization they own (the App needs the
Members read permission to check that). No GitHub token is stored: each operation mints an installation token
limited to one repository and the permissions it needs (`app/lib/.server/github/`).

Opening a project creates a chat bound to it (`chats.org_project_id`) before its agent starts, and the agent seeds the
workspace from the default branch, streamed through the control plane (`/api/cloudflare/runtime-github/snapshot`),
recording the commit and each file's hash. The runtime never holds a GitHub token: snapshot, commit, and build-status
calls are authenticated like the credential broker and re-check the member's access to the project, and that the
project belongs to the organization the runtime runs for (`app/server-handlers/runtime-github.ts`). Validation runs the
repository's own `typecheck`, `lint`, `test`, and `build` scripts. The agent's `publish_preview` commits the workspace's
changes (as git would, leaving out new files the repository's `.gitignore` files ignore, and never sending a local
`.env*` or `.dev.vars*`), one commit on top of the commit it was opened from, to the conversation's own branch
(`cloudchef/<member>-<key>`, the key kept with the workspace's link), and `publish` also merges that branch into the
default branch; the repository's own pipeline (Workers Builds) previews and deploys, and its check runs report the build
and the preview link. A subchat gets its own key, since its parent can go on working; a new conversation keeps the
one it continues, which no longer writes. A workspace keeps GitHub's file modes, so an executable bit changed alone is
committed. Once the commit is on GitHub there's no taking it back: a Stop or the tool's deadline calls a publish off
only before it, and after it the real result lands in place of the stopped call's error. The template's automatic
hosted preview and deployment don't run for these workspaces.

A project has one current conversation per member. Starting a new one archives the current one (kept to read): its
agent refuses new turns, steering, saves, approvals and publishing, its running turn is stopped, and the new
conversation copies its workspace and link only once it has settled. Removing the current conversation makes the
latest archived one current again.

A publish returns as soon as its commit is on GitHub. The pipeline takes minutes, so a durable fiber watches its check
runs (`app/agents/linked-project-build.ts`) and, once the turn that published has ended, puts the result and preview
link in place of that publish's output, as an approved Cloudflare request's result lands: the person sees the card and
the status above the composer update (`app/lib/common/linked-publish.ts` reads them from the output's data, never from
the summary written for the model), and the next turn reads it. Workers Builds' own check runs decide once it has
posted one; until then, for a few minutes, other checks finishing don't count as the build. Any finished run that did
not pass (cancelled, timed out, waiting for an action) fails it. CloudChef does not serve its own instant preview of these workspaces: their builds,
Worker names, and bindings (D1, R2, and more, under any names) are the repository's own, and CloudChef's hosted preview
deploys only its starter apps' configuration, rebuilt from trusted inputs; a member limited to GitHub projects has no
Cloudflare token for it anyway.

The agent's `fetch_site` reads the project's live site, its pages and the JSON they load, which is where a site's copy
from its database or CMS shows. It reaches only the https origins the control plane reports for the repository
(`/api/cloudflare/runtime-github/site`): the website set on GitHub and the links its pipeline posted for the default
branch and the conversation's branch, never an address the workspace names. It sends only GETs, follows redirects only
within those origins, and reads at most 2 MB of a text response. There is no database tool: a database's identity
would come from the workspace's own configuration, D1 has no read-only query mode, and a member limited to GitHub
projects holds no Cloudflare token.

A member's new app (a draft) can be sent for review: the request carries the draft's files. Approving it, an admin
authorizes CloudChef once on GitHub to create a repository as them, the draft becomes its first commit with its
Cloudflare resources named after it, and it becomes a project its requester may work on; the admin connects the
repository to Workers Builds. Clicking Approve claims the request for that admin, so the draft they reviewed is
the one committed: until they return from GitHub, or the claim lapses after 10 minutes, the member can't replace it
and no other admin can decide it, and a replacement after the claim lapsed makes the return refuse. An admin can also limit a member to GitHub projects: that member's runtime is refused the
organization's Cloudflare token by the credential broker, so their work reaches production only through GitHub.

## State Ownership

| State                                                                                             | Authoritative owner                                  |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Identity, OAuth credentials, sessions, connection metadata, runtime locators                      | CloudChef control-plane D1                           |
| Organizations, memberships, invites, per-member daily usage counts                                | CloudChef control-plane D1                           |
| GitHub installations, linked projects and access, production requests                             | CloudChef control-plane D1                           |
| Chat catalog, transcript identity, deployment plans and resources, Agent garbage-collection queue | User workspace D1                                    |
| Agent messages, turn state, compaction, and resumable execution                                   | User-owned `BuilderAgent` DO SQLite                  |
| Project bytes, numeric revision, change index, tool journal, and validation receipts              | User-owned `ProjectWorkspace` Computer VFS/DO SQLite |
| Dependency installation, validation, and deployable artifact preparation                          | User-owned `ProjectWorkspace` Container backend      |
| Preview-version upload and production-version promotion                                           | User's Cloudflare account APIs                       |
| Query collections and editor files                                                                | Rebuildable in-memory browser presentation cache     |
| Generated application's Worker, D1, R2, Agent, and related resources                              | User's Cloudflare account                            |

Do not create a second authoritative store for the same state. Browser and process-local materializations must be
rebuildable from their owner. Cloudflare Computer's SQLite VFS in `ProjectWorkspace` is the sole authority for project
files; the browser editor and container mount are replicas of that state.

## Transcript Reconciliation

`BuilderAgent` DO SQLite is the only authoritative message transcript and checkpoint store. Generation, reload,
interrupted-turn recovery, and context compaction all read that Agent. User workspace D1 stores only routing and catalog
facts: the Agent name, generation, subchat index, branch ancestry, and whether the chat has accepted content. It stores
no message positions, counts, digests, or browser-authored checkpoint. The browser's TanStack collection is a
rebuildable in-memory view. There is no sharing transcript, server-side rewind snapshot, R2 message backup, or
WebContainer snapshot.

Reconciliation is deterministic:

1. Reload resolves the owner-scoped transcript identity from D1 and asks that exact `BuilderAgent` for its checkpoint
   and messages. A mismatched Agent identity or generation is a conflict, never a fallback to another history.
2. Before send, the browser asks the Agent for its current checkpoint and compares it with the complete local view. A
   mismatch blocks the send and requires a reload. The checkpoint rides with the message only as transient base
   metadata, so the Agent rejects a stale client that races after the preflight; it is stripped before persistence.
3. Once the Agent accepts the first user content, it marks the chat visible in D1 using its bound identity. This writes
   one catalog boolean, not a transcript projection. D1 never receives the message body or checkpoint hash.
4. A subchat records its parent subchat, generation, and revision. The runtime reads that revision directly from the
   parent Agent before the D1 transition, then uses a unique token to recognize an exact commit whose acknowledgement
   was lost.

The open issue that introduced this contract referred to R2 transcript objects, browser-produced compressed history,
WebContainer snapshots, and preserving legacy rewind behavior. Those storage planes were retired by the intentional
breaking rebuild. The applicable invariant is therefore readability and recovery of current DO transcripts; importing
or reconciling the retired R2/WebContainer formats is explicitly not a compatibility requirement.

## Project Lifecycle

`BuilderAgent` owns conversation execution and delegates project operations to `ProjectWorkspace`. Cloudflare Computer
stores files directly in the Durable Object's SQLite VFS. Its container backend projects the same files into the
Container through FUSE and reconciles changes back to the VFS. There is no application-level ZIP archive, R2 backup, or
duplicate project blob in the control plane.

The model receives six workspace primitives, split by what they cost. `read`, `ls`, and `grep` are answered from the
Durable Object's SQLite VFS alone; `write`, `edit`, and `exec` change the project or run in its Container. `write` and
`exec` adapt the reviewed `@cloudflare/computer/tools` contracts; CloudChef's `read` returns numbered lines with a
compact tag bound to the full file SHA-256, and `edit` applies non-overlapping line operations only when that exact
snapshot is still current.

Discovery used to go through `exec`, and the cost of that decision was paid on every question about the project's
shape: a container wake or wait, a shell process launch, and a durable filesystem sync barrier, to answer something the
Durable Object holds in SQLite. `ls` enumerates a directory or the tree beneath it and `grep` returns path, 1-based
line, and matching line for a literal pattern, both directly from the VFS — no container, no sync barrier, and never
the exclusive workspace operation lane, so discovery answers before the container is warm and stays available while a
build command holds the lane. Line numbers come from the same splitter `read` and `edit` use, so a search hit names the
line an edit would change. `grep` matches literal single-line text and never compiles the model's pattern into a
regular expression or a shell command: an untrusted pattern must not be able to backtrack the Durable Object into a
stall or inject into the container. Both tools are bounded in the spirit of Computer's reviewed read and exec limits —
`user-workspace-runtime/src/workspace-discovery.ts` names every ceiling and the failure it prevents — and both report
`truncated` so the model narrows the path or the pattern instead of paging blindly. A recursive walk shows
`node_modules` and build output but does not descend into them, unless one of them is the requested path; that is how
the model still reads the framework version the project installed.
Reference guidance is mostly retrieved rather than mirrored. Cloudflare's documentation is searched live through the
`search_cloudflare_docs` tool, one stateless request to the public `docs.mcp.cloudflare.com` endpoint that returns
ranked excerpts with their source URLs; a full page is read by appending `/index.md` to any documentation URL.
Framework references are read from the packages the project itself installed, so they always match the version it
builds against. The builder's skills (`app/lib/.server/llm/builder-skills.ts`) are bundled into the Worker: CloudChef's
own `project-stack`, which covers only what is specific to its starter app, and Cloudflare's official skills, vendored
from github.com/cloudflare/skills at a pinned commit into `app/lib/.server/llm/skills/cloudflare-skills.vendored.ts`
by `pnpm run skills:sync`, so they stay Cloudflare's current guidance rather than a hand-written copy. They are exposed
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
request is marked indeterminate rather than replayed. `cloudflare_api` and `cloudflare_api_write` in the user workspace
`runtime_controls` table are the operator kill switches for reads and writes.

Model tools and editor reads use the same workspace API. Browser saves use
compare-and-swap against the numeric revision the browser loaded; a conflict refreshes from the user runtime and never
overwrites newer state. TanStack DB collections are in-memory presentation caches rebuilt from the user runtime. The
browser has no second SQLite or OPFS copy of chats, transcripts, or workspace files.

The user workspace is a separate workspace package, `@cloudchef/user-workspace-runtime`. Its `./protocol` export is
the only shared source for sync limits, request/result types, preview results, and readiness contracts. The runtime owns
the `ProjectWorkspace` implementation; `computer-sandbox.ts` contains the Cloudflare Computer/Sandbox adapter and
container-process lifecycle. Browser, control-plane, and Agent code import the protocol instead of reaching into that
implementation.

Tool-call arguments stream to the browser as the model produces them. `exec` additionally streams bounded transient
stdout/stderr updates while retaining only a bounded final tail for the model; completion still waits for the Container's
filesystem pull to become durable. The Pi loop enforces a total turn limit, a model-stream inactivity limit, and a first-progress
deadline against a hung provider stream; there is no model-step ceiling. Each tool has a deadline against a hung
operation, and a tool stopped by it is an ordinary failed result the model acts on, not the end of the turn. A tool that
completes as its deadline passes reports what it did; one that has not settled a minute after being stopped ends its
call with an outcome reported as unknown, since the turn's inactivity watchdog is paused while a tool runs. A cancellation requested before a Container process handle exists is retained and applied
as soon as that handle becomes available. Approved `pnpm add <packages>` and `pnpm install --lockfile-only` commands route to
the reviewed dependency installer rather than an unrestricted package-manager shell. The model decides when to run the full
validation and what to tell the user; the runtime neither validates on its behalf nor writes its final message.
Production deployment is not a model capability: when a turn that changed a CloudChef app finishes, `BuilderAgent`
publishes the hosted preview and then admits a durable deployment fiber that runs one authenticated, idempotent server
operation. Each builds the exact revision it was asked for (reusing a validation of that revision when the model
already ran one), prepares the exact-revision plan, and executes it in the user's account. A failed build or
deployment is shown to the user and told to the model at the start of its next turn. The browser can request a retry but is not responsible for starting deployment.
A turn that changes the app, however it ends, durably records that production must catch up (`publicationPending`),
and only production serving the current revision (`productionRevision`) clears it, so a publication cut short is
redone: at the next turn's end, even one that changed nothing, when that turn is stopped or fails before it
streams, and when a restarted agent starts. A message refused before its turn begins stops nothing. No automatic
publication starts while a turn runs, since it holds the workspace's operation lane. The person's next message stops
the one in flight: a preview at its next step, a deployment until just before its migrations and upload (past that it
finishes, since stopping would leave production half changed), and a stopped preview never deploys. A deployment that
failed for a reason that passes (a busy workspace, another deployment of the project, an interruption, an unreachable
credential broker) is retried after 30 seconds, 2 minutes, and 8 minutes, and so is one whose failed record in the
user's account cannot be settled yet before it is redone; a failed build waits for the next turn. A
project deploys one revision at a time; a person's projects deploy independently. Preview and deployment use
checkpoints from the same VFS, so a publication never ships a revision other than the one it was asked for.

## Preview Boundary

A preview is one immutable, checkpoint-bound Worker version in the user's account. Full validation copies the project
to an isolated root, installs dependencies, runs typecheck/lint/stack verification, performs the production build and
`cf deploy --prebuilt` dry run against a trusted `worker.config.json`, and retains the deployable module/asset/migration artifact under the content revision. The exact
revision is asserted before and after validation and again before publication.

Preview publication performs no container work. Through the same generation-checked credential broker used by
production deployment, it provisions separate deterministic preview D1 databases, applies the artifact's migrations,
uploads static assets, and posts an unpromoted Worker version with preview bindings. The browser receives that
version's deterministic `workers.dev` preview URL. There is no dev/HMR mode, local preview database, Vite preview
process, quick tunnel, preview expiry alarm, or preview-specific container keep-alive.

Production consumes the same retained artifact for the same source digest, substitutes production bindings, uploads a
second immutable version, and promotes that exact version. If Computer recycled after validation, artifact preparation
may rebuild from the retained source checkpoint, but its byte inventory must match the durable validation digest.

## Deployment Boundary

Deployment state and resource intent are recorded in the user workspace D1. Execution verifies that Computer's current
content checkpoint still matches the validated revision, reuses the revision-keyed validation artifact, provisions the
requested resources through the user's Cloudflare API authorization, applies migrations, uploads an immutable Worker
version, and promotes that exact version. CloudChef stores no deployment archive outside the user-owned runtime's
recoverable artifact cache.

The deployment executor derives resource names and security-sensitive configuration on the server. It records managed
Worker intent before publishing, then reads back the deployed version, script etag, bindings, variables, and schedules.
Ambiguous publish outcomes remain visible for owner review rather than being silently discarded.

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
their latest release, and adds the protected `src/server.ts` entrypoint, Agent security database, Durable Object export, and cleanup schedule together.
Partial Agent configuration fails validation. When enabled, application data stays in `DB`, while Agent sessions,
retention state, and inference accounting stay in separately provisioned `AGENT_SECURITY_DB`. Only the AppAgent
runtime may import that binding; the protected build policy checks the resolved module graph so aliases and
dependencies cannot widen the capability boundary. The policy is structural rather than pinned to package versions:
only the Agent packages (and capnweb, their RPC layer) may import `cloudflare:workers`, only the protected
entrypoints and those packages may import the Agent runtime, and project code may reach `globalThis`, `self`, or
`window` only through property access, because capnweb keeps the Workers module on the global object under an
unregistered symbol that enumeration would expose. A web framework is the project's own choice: the builder adds one
only when the product needs it, and wires its handler into `src/application.ts` behind the same entrypoints.

Root dependencies do not implicitly apply to the template. Generated bundle source is deliberately ignored rather
than reviewed as source: `pnpm run generate:artifacts` rebuilds both the template snapshot and the user-workspace Worker
bundle, while `pnpm run generate` also refreshes route and binding types. Build, typecheck, and validation each enter
through that generation path once. A template change is complete only when standalone verification passes.
Generated-project package-manager constraints live in
`template/scripts/lib/project-policy/generated-project-dependency-policy.json`; browser admission and repository/template
verification consume that same data rather than maintaining separate security override lists.

## Cloudflare Computer Dependency

CloudChef intentionally pins `@cloudflare/computer` to `0.2.1`. Cloudflare labels this release preview-only, describes
its API as unstable, and says it is not suitable for production use. The repository therefore treats every upgrade as
an architecture review: tests pin the installed version, tool names, complete AI SDK input schemas, result fields used by
the build lifecycle, read-only behavior, backend selector, and backend capability description. Tool configuration
explicitly disables Computer's optional `publish` capability and pins the reviewed default limits: 10,000 lines or 1
MiB per read, 2 MiB per write/edit, and 256 KiB for each exec output stream. These gates detect drift; they cannot turn a
preview dependency into a stable production contract. Computer 0.2.1's published write executor does not forward `ToolExecutionOptions.abortSignal`, so an in-flight vendor
write still relies on the workspace runtime's bounded operation. CloudChef's custom streamed `exec` adapter does forward
cancellation to its Container process.

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
CloudChef starts fresh context windows using builder-authored handoffs, following Ghost's recovery approach.
The `new_context` tool accepts concise continuation state; `history` searches and pages the current authenticated
conversation, including earlier windows. Before the rollover threshold, the builder gets a best-effort reminder to
save notes and hand off. If it reaches the threshold or a provider context overflow first, a bounded deterministic
recovery record retains user inputs, the latest tool batch, and the last authored handoff. No separate summarizer
model is called. The record is not a verified progress summary: the builder must recover details through history and
check current workspace state before continuing. Repeated rollovers preserve the authored checkpoint without nesting
automatic records. The complete transcript remains in the owning Agent; live history ids are turn-local, so after a
restart the builder searches again for durable message ids. Existing summary checkpoints remain readable, and anchor
validation prevents applying a checkpoint after a rewind removed its source. Thresholds follow the selected model's
window, including a smaller limit learned from the provider, with output and estimation headroom reserved.

Long before that threshold, old tool output is cleared from the model's view (`tool-result-clearing.ts`): once the
context passes 64k tokens (or half the input budget of a smaller model), every large tool result except the six most
recent is replaced by a fixed note, keeping each message and tool call in place, and only when that frees at least 12k
tokens. Clearing is rare and step-wise, and the note is byte-identical each time, so the cached prefix holds up to the
first newly cleared result. The transcript and `history` keep the original output.

The installed AI SDK `ToolLoopAgent` remains useful for generated applications, but it does not expose an equivalent to
Pi's one-at-a-time, persistence-before-delivery steering queue or a continuation after a nominally final model response
when steering is pending. Replacing Pi would therefore remove a tested runtime behavior or require another custom loop,
which would not simplify this architecture. The parity review is recorded in `scripts/evaluations/DECISIONS.md`.

Workers AI prefix caching is automatic for supported models. CloudChef sends an opaque, stable session-affinity value
per transcript generation through either the REST header or binding `extraHeaders`, keeps system instructions at the
front of the prompt, and leaves dynamic project context in the latest user turn. Cache availability never changes the model-visible input or correctness path. Finish telemetry aggregates Pi's native
`usage.cacheRead` across model turns and reports cache hits or misses without logging prompt contents. Small historical samples observed lower affinity
latency but reported zero cached tokens, so CloudChef claims no verified cached-token cost savings. The retained
decision record is `scripts/evaluations/DECISIONS.md`.

## Trust Boundaries

User input, generated code, model output, and repository context are untrusted. Secrets remain in server-side
Cloudflare bindings; generated-project actions reject secret files. Generated code never executes in the CloudChef
control-plane Worker. Runtime capabilities are short-lived and bound to the authenticated user and browser origin.
A member's chats, transcripts, and project files live in their organization's Cloudflare account, where its
administrators and account holders can read them; the product says so when someone accepts an invite.
