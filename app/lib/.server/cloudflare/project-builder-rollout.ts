/**
 * Whose projects the ProjectBuilder publishes with the `cf` CLI instead of Wrangler, from
 * `PROJECT_BUILDER_DEPLOYS_WITH_CF` in `cloudflare.config.ts`: empty, nobody's (Wrangler publishes everything, as
 * before `cf` could); a comma-separated list of CloudChef user ids and project ids, the publishes those people's
 * runtimes build and the publishes of those projects; `*`, everyone's. It is asked when a runtime claims a publish,
 * and the answer goes with the claim, so a publish under way finishes with what it started with. `cf` publishes the
 * projects whose build leaves Build Output (a CloudChef app, a `cf` project); one with a Wrangler config of its own is
 * still published by Wrangler (`user-workspace-runtime/src/cf-deploy.ts`).
 */
export function projectBuilderDeploysWithCf(
  env: { PROJECT_BUILDER_DEPLOYS_WITH_CF?: string },
  publish: { userId: string; projectId: string },
): boolean {
  const named = (env.PROJECT_BUILDER_DEPLOYS_WITH_CF ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return named.includes('*') || named.includes(publish.userId) || named.includes(publish.projectId);
}
