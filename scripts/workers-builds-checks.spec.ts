import { describe, expect, it } from 'vitest';
import { workersBuildsChecks } from './workers-builds-checks.mjs';

describe('workersBuildsChecks', () => {
  it('runs the full validation on branch builds and only regenerates outputs on main, whose deploy step validates', () => {
    expect(workersBuildsChecks({ env: { WORKERS_CI_BRANCH: 'feature' } })).toEqual(['run', 'validate']);
    expect(workersBuildsChecks({ env: {} })).toEqual(['run', 'validate']);
    expect(workersBuildsChecks({ env: { WORKERS_CI_BRANCH: 'main' } })).toEqual(['run', 'generate']);
  });
});
