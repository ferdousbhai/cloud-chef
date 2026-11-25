# Architecture experiment decisions

Experiment and review conclusions that still constrain the product.

## Workers AI prefix caching

Two small live samples on 2026-07-16 showed lower latency with stable session affinity, but Workers AI reported zero
cached input tokens. The session affinity and hit/miss telemetry stay (ARCHITECTURE.md, Model Context and Prefix
Caching) because they match Cloudflare's supported automatic prefix-caching contract, but CloudChef claims no
cached-token or cost saving without positive provider telemetry.

## Read-only child agents

A four-case synthetic comparison on 2026-07-16 scored 4/4 for both the single-agent and child-assisted variants. The
assisted variant took 2.05 times the latency and estimated cost. No production child-agent runtime is justified by that
evidence; reconsider only with a larger held-out end-to-end build benchmark showing a material success improvement.

## Repository retrieval

The supported baseline is the authoritative Computer workspace: `ls`, `grep`, and paged `read` answered from the
workspace Durable Object's SQLite VFS without waking the container, and bounded `exec` in the container for anything
else. A semantic index or second repository copy stays deferred until real build tasks demonstrate a material retrieval
gap and an isolated, revision-aware design outperforms that baseline.

## Container provisioning

Workspace containers run on `standard-4` (`app/lib/.server/cloudflare/project-workspace-container-policy.ts`), asked
for at each start under the `durable_object` scheduling policy, which takes no instance limit. The tier is chosen because the slow steps a user
waits on (`pnpm install`, `tsc`, Vite) are CPU-bound and container CPU is billed on active use, so more cores
finish the same work for the same CPU cost; the cost is a larger warm container while idle. No measurements compare
tiers, so capacity is not a benchmark conclusion.

The containers start from Cloudflare's managed `cloudflare/debian-trixie` image, set up once per runtime and kept as
its base snapshot, rather than from an image of CloudChef's own: on 2026-10-29 the owner declined publishing one to
Docker Hub, the `durable_object` policy pulls from no public registry, and Cloudflare's registry is private to each
account. The owner also decided that the container keeps direct internet access (`enableInternet: true`), with only
CloudChef's own hosts (`git.internal`, `cloudflare-api.internal`) intercepted.

## Cloudflare Think

Do not add `@cloudflare/think` to this release. Think owns a SQLite workspace and automatically adds filesystem tools,
which would create a second project filesystem beside the authoritative user-owned Computer workspace. Reconsider only
if Think can disable all local workspace state or accept the existing remote workspace while preserving CloudChef's
revision, authorization, validation, recovery, and deployment-approval invariants.

## Builder loop: Pi versus AI SDK

Superseded on 2026-10-29: the builder runs on `@earendil-works/pi-durable` (hosted by the Agents SDK's `PiHarness`), whose
durable inbox carries the steering this review kept Pi for, and `@earendil-works/pi-agent-core` is no longer a dependency.
The review as it was:

Reviewed on 2026-08-22 against the installed `@earendil-works/pi-agent-core` 0.83.0 and AI SDK 7.0.48. Keep Pi for the
builder loop. AI SDK's `ToolLoopAgent` has step preparation, stop conditions, tool lifecycle callbacks, streaming, and
abort support, so ordinary tool execution is close. It does not have Pi's `getSteeringMessages` contract: a committed
message can be delivered one at a time between turns, clear a previously validated completion, and cause continuation
even after the model's preceding response would otherwise be final. CloudChef also has tested Pi adapters for partial
tool-call argument streaming, transient execution progress, failed-result reclassification, live context compaction,
one invisible overflow retry, inactivity/wall-clock budgets, and cancellation accounting.

An AI SDK rewrite could recreate much of this around `prepareStep` and stream callbacks, but that would be another
custom loop and no parity implementation currently passes the existing steering, progress, cancellation, compaction,
and recovery tests. Removing two dependencies is not worth changing those semantics. Reconsider only when a replacement
passes those tests without a second orchestration layer or a fixed step ceiling.

## Moving CloudChef apps onto Workers Builds

Checked on 2026-10-29: Workers Builds cannot yet be connected to an Artifacts repository through Cloudflare's API, so
CloudChef apps (`p-<chat>` repositories) stay on CloudChef's own deployment and are not moved. The API's repository
connection (`PUT /accounts/{account_id}/builds/repos/connections`) and Worker build configuration
(`POST /accounts/{account_id}/builds/workers`) accept `provider_type` `github`, `gitlab`, `gitlab_internal` and `origin`
(Cursor Origin) only, in Cloudflare's OpenAPI schema (github.com/cloudflare/api-schemas, 2026-10-28) and in `cf builds
repos connections upsert`. Reading a trigger does report `provider_type: "cloudflare_artifacts"` (the team projects'
triggers, made in the dashboard on 2026-10-24 with a dashboard-named build token), but that value is not accepted or
documented for writing, and CloudChef does not call undocumented values. The Artifacts integration page
(developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/) and the Builds API reference
(updated 2026-10-28) describe connecting Artifacts in the dashboard only. Recheck when `cloudflare_artifacts` (or
another Artifacts provider) appears in the connection's `provider_type` enum.

Each new app would need an admin's dashboard step before its first publish, which a chat cannot wait on. If apps move
off the deployment pipeline before that, CloudChef's own builder (`ProjectBuilder`, `deploys_with = 'cloudchef'`), which
already builds and deploys uploaded projects from their Artifacts repository with no dashboard step, is the fitting
path: apps are generated by CloudChef, not built by their owners' own scripts as the team's two sites are.

## CloudChef hosts no space in its own account

From 2026-11-21 to 2026-11-25 CloudChef sold subscriptions to spaces that built in the operator's own Cloudflare
account, for people with no account of their own. It was withdrawn. A subscriber's published Worker ran in that
account, and the deploy policy (`app/lib/.server/cloudflare/deploy-api-policy.ts`) keeps a project only from
resources named for CloudChef, so it could bind any other database, bucket, queue or Worker there, and run SQL on any
other D1 database while publishing. Cloudflare's Tenant API, which would give each space an account of its own, is
closed to new participants (asked 2026-11-23). A space builds only in a Cloudflare account its own admins connected;
someone without one is invited into a space by a person who trusts them with that account. Migration 0075 closed the
spaces made in those days. Reconsider only with an account per space.

## A collaborator works with what the project already has

Decided by the owner on 2026-11-25. Anyone may sign up (Cloudflare, Google or an emailed link), and an account with
no Cloudflare account of its own and no project it was added to can only look, follow, like and comment: it has no
workspace, container or model. Someone a creator adds to a project builds in the creator's account and uses the
project's resources there, and adds none. A publish is a collaborator's when it runs for anyone who neither made the
project nor is an admin of its space (`publishesAsCollaborator` in `app/server-handlers/runtime-deployments.ts`,
kept as `project_deployments.restricted`), and so is the preview of a change someone offered, whoever's reading of
the thread built it. The builder holds such a publish to what the project's live Worker already uses, read from
Cloudflare when it uploads (`addedResources` in `deploy-api-policy.ts`): no new database, namespace or bucket, no
SQL on a database the Worker doesn't bind, and no binding the Worker doesn't have, Workers AI, Browser Rendering and
sending email among them. A starter app's own database, storage and cache are found, never made. What a version adds
is said on the failed publish, and its creator or an admin publishes it by trying that publish again, which is the
approval; there is no separate request. The control plane gives the account's authorization for a collaborator's
publish only to a runtime that says it holds it so.

Not covered: a project Workers Builds publishes (imported from GitHub) is built by Cloudflare with the account's
own build token, from the repository's Wrangler config, so someone who may edit it can add a binding there. Give
edit on such a project only to someone trusted with the account.

## One way to be on someone else's project

Decided by the owner on 2026-11-25, to make CloudChef read like a successor to GitHub for people who don't write
code: an owner, and the people the owner adds to a project. Until then there were three overlapping ways (an admin
of a space, a member invited into it, and someone a project was shared with who worked on it from a Cloudflare
account of their own), each with a different answer to whose account pays and where a publish goes. Now sharing a
project is the one way in: it adds the person to that project, in the project's own Cloudflare account, which pays
for their workspace and model whether or not they have an account of their own. A space is only the plumbing for
that (who may run a workspace in an account); nobody is asked to think about one. Migration 0078 moved the shares
made before into their projects' accounts.

The owner also decided, the same day: no new spaces are made beside a person's own ("New space" is gone; the ones
there are carry on); the space invite, its `/join` page and "may start apps of their own" are gone, so only a
space's admins start projects in it; and there is no third level beside view and edit: someone trusted with the
account comes in through a project and is made an admin in Settings. Not covered: a project Workers Builds
publishes, which the collaborator rule above doesn't hold.
