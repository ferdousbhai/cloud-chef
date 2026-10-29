/**
 * Who an outdated workspace runtime is upgraded for, from `WORKSPACE_RUNTIME_UPGRADE_CANARY` in
 * `cloudflare.config.ts`: empty, everyone (a session request upgrades its own runtime, and the scheduled
 * sweep the rest); a comma-separated list of CloudChef user ids, only theirs. A runtime left out keeps
 * serving its person as it is, as any runtime from an earlier release does while its upgrade waits, so a
 * canary never interrupts anyone. A first workspace is always prepared on the current release.
 */
export function workspaceRuntimeUpgradeAllowed(
  env: { WORKSPACE_RUNTIME_UPGRADE_CANARY?: string },
  userId: string,
): boolean {
  const canary = workspaceRuntimeUpgradeCanary(env);
  return canary === null || canary.has(userId);
}

function workspaceRuntimeUpgradeCanary(env: { WORKSPACE_RUNTIME_UPGRADE_CANARY?: string }): ReadonlySet<string> | null {
  const ids = (env.WORKSPACE_RUNTIME_UPGRADE_CANARY ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}
