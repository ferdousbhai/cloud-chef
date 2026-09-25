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

## State Ownership

| State                                                                                             | Authoritative owner                                  |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Identity, OAuth credentials, sessions, connection metadata, runtime locators                      | CloudChef control-plane D1                           |
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
Reference guidance is retrieved rather than mirrored. Cloudflare's own documentation is searched live through the
`search_cloudflare_docs` tool, one stateless request to the public `docs.mcp.cloudflare.com` endpoint that returns
ranked excerpts with their source URLs; a full page is read by appending `/index.md` to any documentation URL.
Framework references are read from the packages the project itself installed, so they always match the version it
builds against. The one skill CloudChef maintains ships in this repository and is bundled into the Worker, exposed
through the existing `read` tool under `/__skills__/<skill>/`; no activation or separate resource-reader tool is
added. That namespace is a read-only control-plane overlay: it never enters the project VFS, revision, or deployment
artifact, project files cannot shadow it, and it never appears in `ls` or `grep`, which are asked only about the
project. The evergreen system prompt establishes only authority, safety, and
workflow precedence; concrete product and API guidance comes from retrieval, while code and deployment boundaries
remain enforced by project validation. A documentation search that fails returns a failed tool result the model can
act on, rather than ending the turn.

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
filesystem pull to become durable. The Pi loop enforces a total turn limit, model-stream inactivity limit, and per-tool
limits; there is no model-step ceiling. A cancellation requested before a Container process handle exists is retained and applied
as soon as that handle becomes available. Approved `pnpm add <packages>` and `pnpm install --lockfile-only` commands route to
the reviewed dependency installer rather than an unrestricted package-manager shell. After related mutations are complete,
the model requests one full validation and receives its revision-bound receipt. Production deployment
is not a model capability: after validation, `BuilderAgent` admits a durable deployment fiber that runs one authenticated,
idempotent server operation, verifies the current receipt, prepares the exact-revision plan, and executes it in the user's
account. The browser can request a retry but is not responsible for starting deployment. Preview and deployment use
checkpoints from the same VFS, so deployment cannot proceed after the project changes.

## Preview Boundary

A preview is one immutable, checkpoint-bound Worker version in the user's account. Full validation copies the project
to an isolated root, installs dependencies, runs typecheck/lint/stack verification, performs the production build and
Wrangler dry-run, and retains the deployable module/asset/migration artifact under the content revision. The exact
revision is asserted before and after validation and again before publication.

Preview publication performs no container work. Through the same generation-checked credential broker used by
production deployment, it provisions separate deterministic preview D1 databases, applies the artifact's migrations,
uploads static assets, and posts an unpromoted Worker version with preview bindings. The browser receives that
version's deterministic `workers.dev` preview URL. There is no dev/HMR mode, local preview database, Vite preview
process, quick tunnel, preview expiry alarm, or preview-specific container keep-alive.

Production consumes the same retained artifact for the same source digest, substitutes production bindings, uploads a
second immutable version, and promotes that exact version. If Computer recycled after validation, artifact preparation
may rebuild from the retained source checkpoint, but its byte inventory must match the durable validation digest.
OAuth credentials and control-plane secrets never enter generated project processes.

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

`template/` is an independent application. Its default is a plain TanStack Worker entrypoint with no Workers AI
binding, Agent Durable Object, Agent security D1, cleanup cron, or Agent/AI packages. A project that needs durable AI
runs `pnpm run agent:enable`; the idempotent command applies the reviewed capability manifest, exact dependency pins,
protected `src/server.ts` entrypoint, Agent security database, Durable Object export, and cleanup schedule together.
Partial Agent configuration fails validation. When enabled, application data stays in `DB`, while Agent sessions,
retention state, and inference accounting stay in separately provisioned `AGENT_SECURITY_DB`. Only the AppAgent
runtime may import that binding; the protected build policy checks the resolved module graph so aliases and
dependencies cannot widen the capability boundary.

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
