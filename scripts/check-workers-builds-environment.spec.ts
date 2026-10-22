import { describe, expect, it, vi } from 'vitest';
import { checkWorkersBuildEnvironment } from './check-workers-builds-environment.mjs';

const commitSha = 'a'.repeat(40);
const toolchain = { node: '26.3.0', pnpm: '11.14.0' };
const env = {
  WORKERS_CI: '1',
  WORKERS_CI_BRANCH: 'main',
  WORKERS_CI_BUILD_UUID: '11111111-2222-3333-8444-555555555555',
  WORKERS_CI_COMMIT_SHA: commitSha,
};

describe('Workers Builds environment preflight', () => {
  it('requires the pinned toolchain', () => {
    const spawn = vi.fn((command: string) => {
      if (command === 'git') {
        return { status: 0, stdout: `${commitSha}\n`, stderr: '' };
      }
      return { status: 0, stdout: '11.14.0\n', stderr: '' };
    });
    expect(() =>
      checkWorkersBuildEnvironment({ env, nodeVersion: 'v26.3.0', toolchain, spawn: spawn as never }),
    ).not.toThrow();
    expect(spawn).toHaveBeenCalledWith('pnpm', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(spawn).not.toHaveBeenCalledWith('docker', expect.anything(), expect.anything());
  });

  it('accepts non-production branch builds for Cloudflare-native PR validation', () => {
    const spawn = vi.fn((command: string) => {
      if (command === 'git') {
        return { status: 0, stdout: `${commitSha}\n`, stderr: '' };
      }
      return { status: 0, stdout: '11.14.0\n', stderr: '' };
    });
    expect(() =>
      checkWorkersBuildEnvironment({
        env: { ...env, WORKERS_CI_BRANCH: 'feature/cloudflare-preview' },
        nodeVersion: 'v26.3.0',
        toolchain,
        spawn: spawn as never,
      }),
    ).not.toThrow();
  });

  it('fails before deployment when pnpm drifts', () => {
    const spawn = vi.fn((command: string) => {
      if (command === 'git') {
        return { status: 0, stdout: `${commitSha}\n`, stderr: '' };
      }
      return { status: 0, stdout: '11.13.0\n', stderr: '' };
    });
    expect(() =>
      checkWorkersBuildEnvironment({ env, nodeVersion: 'v26.3.0', toolchain, spawn: spawn as never }),
    ).toThrow('Workers Builds must use pnpm 11.14.0; found 11.13.0.');
  });
});
