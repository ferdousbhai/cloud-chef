import { describe, expect, it } from 'vitest';
import {
  PROJECT_WORKSPACE_CONTAINER_DIMENSIONS,
  PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
  PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES,
} from './project-workspace-container-policy';

/**
 * Cloudflare instance types reviewed for the Computer workspace runtime. A tier
 * outside this set has never been sized against CloudChef's install, typecheck,
 * build, validation, and preview workloads and must not reach an account.
 */
const REVIEWED_INSTANCE_TYPES = ['basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4'] as const;

describe('ProjectWorkspace container policy', () => {
  it('selects one reviewed Cloudflare instance type', () => {
    expect(REVIEWED_INSTANCE_TYPES).toContain(PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE);
  });

  it('caps concurrent workspace containers at a reviewed launch ceiling', () => {
    expect(Number.isInteger(PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES)).toBe(true);
    expect(PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES).toBeGreaterThan(0);
    expect(PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES).toBeLessThanOrEqual(10);
  });
});

describe('resolved dimensions', () => {
  // A readback accepts either the tier name or these, so a tier change that left them
  // behind would keep accepting a container the policy no longer asks for.
  const BY_TIER = {
    basic: { vcpu: 0.25, memoryMib: 1_024, diskMb: 4_000 },
    'standard-1': { vcpu: 0.5, memoryMib: 4_096, diskMb: 8_000 },
    'standard-2': { vcpu: 1, memoryMib: 6_144, diskMb: 12_000 },
    'standard-3': { vcpu: 2, memoryMib: 8_192, diskMb: 16_000 },
    'standard-4': { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 },
  } as const;

  it('matches the tier the policy selects', () => {
    expect(PROJECT_WORKSPACE_CONTAINER_DIMENSIONS).toEqual(BY_TIER[PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE]);
  });
});
