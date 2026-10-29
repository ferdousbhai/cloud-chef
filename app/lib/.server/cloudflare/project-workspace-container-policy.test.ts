import { describe, expect, it } from 'vitest';
import { PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE } from './project-workspace-container-policy';

/**
 * Cloudflare instance types reviewed for the Computer workspace runtime. A tier
 * outside this set has never been sized against CloudChef's install, typecheck,
 * build, validation, and preview workloads and must not reach an account.
 */
const REVIEWED_INSTANCE_TYPES = ['standard-1', 'standard-2', 'standard-3', 'standard-4'] as const;

describe('ProjectWorkspace container policy', () => {
  it('selects one reviewed Cloudflare instance type, which a durable_object start accepts', () => {
    expect(REVIEWED_INSTANCE_TYPES).toContain(PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE);
    const instance: ContainerStartupOptions['instance'] = PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE;
    expect(instance).toBe('standard-4');
  });
});
