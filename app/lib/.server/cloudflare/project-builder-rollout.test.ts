import { describe, expect, it } from 'vitest';
import { projectBuilderDeploysWithCf } from './project-builder-rollout';

describe('who the builder publishes with cf for', () => {
  const publish = { userId: 'user-1', projectId: 'project-1' };

  it('is nobody while the variable is empty or missing, so Wrangler publishes everything', () => {
    expect(projectBuilderDeploysWithCf({}, publish)).toBe(false);
    expect(projectBuilderDeploysWithCf({ PROJECT_BUILDER_DEPLOYS_WITH_CF: '' }, publish)).toBe(false);
    expect(projectBuilderDeploysWithCf({ PROJECT_BUILDER_DEPLOYS_WITH_CF: ' , ' }, publish)).toBe(false);
  });

  it('is the runtimes and the projects it names, and no other', () => {
    expect(projectBuilderDeploysWithCf({ PROJECT_BUILDER_DEPLOYS_WITH_CF: 'user-1' }, publish)).toBe(true);
    expect(projectBuilderDeploysWithCf({ PROJECT_BUILDER_DEPLOYS_WITH_CF: 'user-2, project-1' }, publish)).toBe(true);
    expect(projectBuilderDeploysWithCf({ PROJECT_BUILDER_DEPLOYS_WITH_CF: 'user-2,project-2' }, publish)).toBe(false);
    expect(projectBuilderDeploysWithCf({ PROJECT_BUILDER_DEPLOYS_WITH_CF: 'user-10' }, publish)).toBe(false);
  });

  it('is everyone once it holds a star', () => {
    expect(projectBuilderDeploysWithCf({ PROJECT_BUILDER_DEPLOYS_WITH_CF: '*' }, publish)).toBe(true);
  });
});
