/**
 * `standard-4` rather than `standard-1`, because every slow step a user waits on inside this
 * container is CPU-bound: `pnpm install`, `tsc`, `eslint`, and Vite/Rollup. `standard-1` gives
 * the workspace half a core, so a typecheck that takes seconds on a laptop takes minutes here,
 * and Rollup and tsc cannot use the parallelism they are built around.
 *
 * The tier is not a cost/speed trade. Cloudflare bills container CPU on *active usage*, so the
 * same work costs the same vCPU-seconds at any tier; memory and disk are billed on provisioned
 * size but only while the instance is awake, and four times the cores finishes in a small
 * fraction of the wall time. A build on `standard-4` therefore costs less than the same build on
 * `standard-1`.
 *
 * What does get more expensive is idling: a warm container holds 12 GiB instead of 4, roughly
 * $0.11 per idle hour, and the workspace is now warmed when a chat opens rather than when the
 * first command runs — so a chat nobody sends a message in still pays. The workspace runtime's
 * ten-minute idle window bounds that cost.
 *
 * Under the `durable_object` scheduling policy the size is asked for at each `ctx.container.start()`, by the
 * workspace and the project builder alike, rather than set on the application, which takes no instance limit
 * either: each of those Durable Objects runs at most one container, so how many run at once follows how many
 * workspaces and publishes are in use.
 */
export const PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE = 'standard-4';
