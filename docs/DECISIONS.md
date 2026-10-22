# Architecture experiment decisions

Experiment and review conclusions that still constrain the product.

## Workers AI prefix caching

Two small live samples on 2026-07-16 showed lower latency with stable session affinity, but Workers AI reported zero
cached input tokens. Production keeps an opaque per-transcript affinity (the `x-session-affinity` header, sent through
the AI binding's `extraHeaders`) and privacy-safe hit/miss telemetry because both match Cloudflare's supported automatic
prefix-caching contract. CloudChef claims no cached-token or cost saving without positive provider telemetry.

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

Workspace containers run on `standard-4` with a maximum of 10 instances
(`app/lib/.server/cloudflare/project-workspace-container-policy.ts`). The tier is chosen because the slow steps a user
waits on (`pnpm install`, `tsc`, `eslint`, Vite) are CPU-bound and container CPU is billed on active use, so more cores
finish the same work for the same CPU cost; the cost is a larger warm container while idle. No measurements compare
tiers, so capacity is not a benchmark conclusion.

## Cloudflare Think

Do not add `@cloudflare/think` to this release. Think owns a SQLite workspace and automatically adds filesystem tools,
which would create a second project filesystem beside the authoritative user-owned Computer workspace. Reconsider only
if Think can disable all local workspace state or accept the existing remote workspace while preserving CloudChef's
revision, authorization, validation, recovery, and deployment-approval invariants.

## Builder loop: Pi versus AI SDK

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
