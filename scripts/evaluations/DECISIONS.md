# Architecture experiment decisions

This file preserves conclusions that still affect the product. The one-off remote Workers and speculative benchmark
drivers were removed because they were not production paths and keeping executable experiments implied support and
repeatability that the project does not provide.

## Workers AI prefix caching

Two small live samples on 2026-07-16 showed lower latency with stable session affinity, but Workers AI reported zero
cached input tokens. Production keeps an opaque transcript affinity and privacy-safe hit/miss telemetry because both
match Cloudflare's supported automatic prefix-caching contract. CloudChef claims no cached-token or cost saving without
positive provider telemetry.

## Read-only child agents

A four-case synthetic comparison on 2026-07-16 scored 4/4 for both the single-agent and child-assisted variants. The
assisted variant took 2.05 times the latency and estimated cost. No production child-agent runtime is justified by that
evidence; reconsider only with a larger held-out end-to-end build benchmark showing a material success improvement.

## Repository retrieval

No live repository-retrieval artifact was produced. The supported baseline remains the authoritative Computer
workspace with bounded `exec` search and paged `read`. A semantic index or second repository copy remains deferred until
real build tasks demonstrate a material retrieval gap and an isolated, revision-aware design outperforms that baseline.

## Container provisioning

No CloudChef staging measurements compare Cloudflare container tiers. `basic` and a maximum of 10 instances are
provisioning defaults, not benchmark conclusions. Any launch capacity or tier claim still requires measured staging
load against the exact release candidate and retained provider telemetry outside this source tree.

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
