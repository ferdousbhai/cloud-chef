import { describe, expect, it } from 'vitest';
import { workspaceRuntimeUpgradeAllowed } from './user-workspace-runtime-rollout';

describe('workspace runtime upgrade canary', () => {
  it('upgrades everyone when no canary is named', () => {
    expect(workspaceRuntimeUpgradeAllowed({}, 'user-1')).toBe(true);
    expect(workspaceRuntimeUpgradeAllowed({ WORKSPACE_RUNTIME_UPGRADE_CANARY: '' }, 'user-1')).toBe(true);
  });

  it('upgrades only the named people while a canary is named, however the list is spaced', () => {
    const env = { WORKSPACE_RUNTIME_UPGRADE_CANARY: ' owner-1 , ,owner-2' };
    expect(workspaceRuntimeUpgradeAllowed(env, 'owner-1')).toBe(true);
    expect(workspaceRuntimeUpgradeAllowed(env, 'owner-2')).toBe(true);
    expect(workspaceRuntimeUpgradeAllowed(env, 'teammate')).toBe(false);
  });

  it('treats a list of only separators as no canary', () => {
    expect(workspaceRuntimeUpgradeAllowed({ WORKSPACE_RUNTIME_UPGRADE_CANARY: ' , ' }, 'anyone')).toBe(true);
  });
});
