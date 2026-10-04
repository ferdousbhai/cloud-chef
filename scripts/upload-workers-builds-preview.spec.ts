import { describe, expect, it, vi } from 'vitest';
import {
  uploadWorkersBuildsPreview,
  validatePreviewBuildContext,
  cfPreviewUploadArgs,
} from './upload-workers-builds-preview.mjs';

const commitSha = 'a'.repeat(40);
const previewEnv = {
  WORKERS_CI: '1',
  WORKERS_CI_BRANCH: 'feature/cloudflare-preview',
  WORKERS_CI_BUILD_UUID: '11111111-2222-3333-8444-555555555555',
  WORKERS_CI_COMMIT_SHA: commitSha,
  CLOUDFLARE_OAUTH_CLIENT_ID: 'oauth-client-id',
};

describe('Workers Builds preview upload', () => {
  it('accepts only a non-production Workers Builds checkout', () => {
    expect(validatePreviewBuildContext({ env: previewEnv, currentCommitSha: commitSha })).toEqual({
      branch: 'feature/cloudflare-preview',
      commitSha,
    });
    expect(() =>
      validatePreviewBuildContext({
        env: { ...previewEnv, WORKERS_CI_BRANCH: 'main' },
        currentCommitSha: commitSha,
      }),
    ).toThrow('refuses the production branch');
  });

  it('builds with reviewed variables and uploads that build as a version without promoting it', () => {
    expect(cfPreviewUploadArgs(commitSha, 'feature/cloudflare-preview')).toEqual([
      'exec',
      'cf',
      'workers',
      'versions',
      'create',
      '--prebuilt',
      '--message',
      `Workers Builds preview for feature/cloudflare-preview at ${commitSha}`,
    ]);

    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `${commitSha}\n`, stderr: '' })
      .mockReturnValue({ status: 0 });
    const readBuiltConfig = () =>
      JSON.stringify({
        env: {
          COMMIT_SHA: { type: 'text', value: commitSha },
          CLOUDFLARE_OAUTH_CLIENT_ID: { type: 'text', value: 'oauth-client-id' },
        },
      });
    expect(uploadWorkersBuildsPreview({ env: previewEnv, spawn: spawn as never, readBuiltConfig })).toBe(commitSha);
    const deployEnv = { ...previewEnv, COMMIT_SHA: commitSha };
    expect(spawn).toHaveBeenNthCalledWith(2, 'pnpm', ['exec', 'vite', 'build'], { stdio: 'inherit', env: deployEnv });
    expect(spawn).toHaveBeenLastCalledWith('pnpm', cfPreviewUploadArgs(commitSha, 'feature/cloudflare-preview'), {
      stdio: 'inherit',
      env: deployEnv,
    });
  });
});
