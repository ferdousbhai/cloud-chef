import { describe, expect, it } from 'vitest';
import { workersBuildsBranch } from './workers-builds-branch.mjs';

describe('Workers Builds branch step', () => {
  it('reports a validated branch without uploading anything', () => {
    expect(workersBuildsBranch({ env: { WORKERS_CI_BRANCH: 'feature/x' } })).toBe(
      'Validated feature/x. Branch builds upload no Worker version.',
    );
  });

  it('refuses the production branch and runs outside Workers Builds', () => {
    expect(() => workersBuildsBranch({ env: { WORKERS_CI_BRANCH: 'main' } })).toThrow('workers-builds:deploy');
    expect(() => workersBuildsBranch({ env: {} })).toThrow('only in Workers Builds');
  });
});
