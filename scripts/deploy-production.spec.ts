import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  deployAndVerifyProduction,
  deployFromWorkersBuilds,
  deployProduction,
  findUnexpectedDeployChanges,
  resolveCurrentCommitSha,
  resolveDeployableCommitSha,
  validateCommitSha,
  validateOAuthClientId,
  validateLocalDeployContext,
  validateWorkersBuildContext,
  validateWorkersBuildMetadata,
  verifyBuiltDeployVars,
  BUILT_WORKER_CONFIG_PATH,
  WORKERS_BUILDS_PRE_DEPLOY_STEPS,
} from './deploy-production.mjs';

const commitSha = 'a'.repeat(40);
const builtConfig = (vars: Record<string, string>) => () =>
  JSON.stringify({
    name: 'cloudchef',
    env: Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, { type: 'text', value }])),
  });
const readBuiltConfig = builtConfig({ COMMIT_SHA: commitSha, CLOUDFLARE_OAUTH_CLIENT_ID: 'oauth-client-id' });
const workersBuildEnv = {
  WORKERS_CI: '1',
  WORKERS_CI_BRANCH: 'main',
  WORKERS_CI_BUILD_UUID: '11111111-2222-3333-8444-555555555555',
  WORKERS_CI_COMMIT_SHA: commitSha,
};

function expectOrdered(content: string, steps: readonly string[]) {
  let previous = -1;
  for (const step of steps) {
    const index = content.indexOf(step);
    expect(index, `${step} must be present`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe('production deploy wrapper', () => {
  describe('local deploy context', () => {
    /** Answer the exact `git` queries the guard makes, in order. */
    function git(branch: string, remoteSha: string, headSha = commitSha) {
      return vi.fn((_command: string, args: readonly string[]) => {
        if (args.includes('--abbrev-ref')) {
          return { status: 0, stdout: `${branch}\n` };
        }
        if (args.includes('origin/main^{commit}')) {
          return { status: 0, stdout: `${remoteSha}\n` };
        }
        return { status: 0, stdout: `${headSha}\n` };
      });
    }

    it('accepts a clean main checkout that matches the pushed commit', () => {
      expect(validateLocalDeployContext({ spawn: git('main', commitSha) as never, currentCommitSha: commitSha })).toBe(
        commitSha,
      );
    });

    it('refuses to deploy a branch that is not the production branch', () => {
      expect(() =>
        validateLocalDeployContext({ spawn: git('feature', commitSha) as never, currentCommitSha: commitSha }),
      ).toThrow(/requires the main branch/);
    });

    it('refuses a commit that has not been pushed, so COMMIT_SHA stays reachable', () => {
      expect(() =>
        validateLocalDeployContext({ spawn: git('main', 'b'.repeat(40)) as never, currentCommitSha: commitSha }),
      ).toThrow(/already-pushed commit/);
    });

    it('does not require the Workers Builds environment', () => {
      // The whole point: a workstation has no WORKERS_CI_* metadata to offer.
      expect(() =>
        validateLocalDeployContext({ spawn: git('main', commitSha) as never, currentCommitSha: commitSha }),
      ).not.toThrow();
    });
  });

  it('allows only validation-generated build output changes in Workers Builds', () => {
    const generatedChanges = ' M app/routeTree.gen.ts';
    expect(findUnexpectedDeployChanges(generatedChanges, { workersBuild: true })).toEqual([]);
    expect(findUnexpectedDeployChanges(generatedChanges)).toEqual(generatedChanges.split('\n'));
    expect(
      findUnexpectedDeployChanges(`${generatedChanges}\n M app/server.ts\n?? unexpected.txt`, { workersBuild: true }),
    ).toEqual([' M app/server.ts', '?? unexpected.txt']);
    expect(findUnexpectedDeployChanges(' D app/routeTree.gen.ts', { workersBuild: true })).toEqual([
      ' D app/routeTree.gen.ts',
    ]);
  });

  it('exposes only the ordered Workers Builds production path', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.deploy).toBeUndefined();
    expect(packageJson.scripts['deploy:preflight']).toBeUndefined();
    expect(packageJson.scripts['deploy:production']).toBeUndefined();
    expect(packageJson.scripts['release:production']).toBeUndefined();
    expect(packageJson.scripts['workers-builds:deploy']).toBe('node scripts/deploy-production.mjs --workers-builds');
    expectOrdered(WORKERS_BUILDS_PRE_DEPLOY_STEPS.join(' && '), [
      'provision:production:check',
      'verify:production-config',
      'verify:workers-builds-config',
      'd1:bookmark:production',
      'd1:migrations:apply:production',
    ]);
    expect(existsSync(new URL('../.github/workflows/deploy.yml', import.meta.url))).toBe(false);
  });

  it('requires a bounded, single-line OAuth client id', () => {
    expect(validateOAuthClientId('oauth-client-id')).toBe('oauth-client-id');
    expect(() => validateOAuthClientId(undefined)).toThrow(
      'CLOUDFLARE_OAUTH_CLIENT_ID must be configured as a non-secret deploy environment variable.',
    );
    expect(() => validateOAuthClientId(' oauth-client-id')).toThrow('may contain only letters');
    expect(() => validateOAuthClientId('oauth\nclient')).toThrow('may contain only letters');
    expect(() => validateOAuthClientId('oauth;client')).toThrow('may contain only letters');
    expect(() => validateOAuthClientId('x'.repeat(513))).toThrow('must be at most 512 characters');
  });

  it('derives and validates the exact current commit', () => {
    expect(validateCommitSha(commitSha)).toBe(commitSha);
    expect(() => validateCommitSha('abc123')).toThrow('exact lowercase 40-hex');
    expect(() => validateCommitSha('A'.repeat(40))).toThrow('exact lowercase 40-hex');
    expect(
      resolveCurrentCommitSha({
        spawn: vi.fn(() => ({ status: 0, stdout: `${commitSha}\n`, stderr: '' })) as never,
      }),
    ).toBe(commitSha);
    expect(() =>
      resolveCurrentCommitSha({
        spawn: vi.fn(() => ({ status: 128, stdout: '', stderr: 'not a repository' })) as never,
      }),
    ).toThrow('Unable to resolve the current Git commit: not a repository');

    const cleanSpawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `${commitSha}\n`, stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    expect(resolveDeployableCommitSha({ spawn: cleanSpawn as never, env: workersBuildEnv })).toBe(commitSha);
    expect(cleanSpawn).toHaveBeenLastCalledWith(
      'git',
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
        '--',
        ':(top).env',
        ':(top).env.*',
        ':(top).dev.vars',
        ':(top).dev.vars*',
        ':(top)*.vars',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const dirtySpawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `${commitSha}\n`, stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: ' M app/server.ts\n', stderr: '' });
    expect(() => resolveDeployableCommitSha({ spawn: dirtySpawn as never, env: workersBuildEnv })).toThrow(
      'Production deploy requires a clean Git worktree',
    );

    const ignoredEnvSpawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `${commitSha}\n`, stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '.env.production\0', stderr: '' });
    expect(() => resolveDeployableCommitSha({ spawn: ignoredEnvSpawn as never, env: workersBuildEnv })).toThrow(
      'Production deploy refuses ignored root .env*, .dev.vars*, and *.vars files',
    );

    expect(() =>
      resolveDeployableCommitSha({
        spawn: vi.fn(() => ({ status: 0, stdout: `${commitSha}\n`, stderr: '' })) as never,
        env: {},
      }),
    ).toThrow('Cloudflare Workers Builds requires WORKERS_CI=1');
  });

  it('binds Workers Builds releases to main, the exact checkout, and a build UUID', () => {
    expect(
      validateWorkersBuildMetadata({
        env: { ...workersBuildEnv, WORKERS_CI_BRANCH: 'feature/cloudflare-preview' },
        currentCommitSha: commitSha,
      }),
    ).toEqual({ branch: 'feature/cloudflare-preview', commitSha });
    expect(
      validateWorkersBuildContext({
        env: workersBuildEnv,
        spawn: vi.fn(() => ({ status: 0, stdout: `${commitSha}\n`, stderr: '' })) as never,
      }),
    ).toBe(commitSha);
    expect(() =>
      validateWorkersBuildContext({
        env: { ...workersBuildEnv, WORKERS_CI_BRANCH: 'feature' },
        currentCommitSha: commitSha,
      }),
    ).toThrow('requires the main branch');
    expect(() =>
      validateWorkersBuildContext({
        env: { ...workersBuildEnv, WORKERS_CI_COMMIT_SHA: 'b'.repeat(40) },
        currentCommitSha: commitSha,
      }),
    ).toThrow('does not match the checked-out commit');
    expect(() =>
      validateWorkersBuildContext({
        env: { ...workersBuildEnv, WORKERS_CI_BUILD_UUID: 'not-a-uuid' },
        currentCommitSha: commitSha,
      }),
    ).toThrow('must be a lowercase UUID');
  });

  it('builds with the OAuth ID and exact commit, then ships that build with cf without a shell', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    expect(
      deployProduction({ clientId: 'oauth-client-id', commitSha, env: workersBuildEnv, spawn, readBuiltConfig }),
    ).toBe(commitSha);
    const deployEnv = { ...workersBuildEnv, COMMIT_SHA: commitSha, CLOUDFLARE_OAUTH_CLIENT_ID: 'oauth-client-id' };
    expect(spawn.mock.calls).toEqual([
      ['pnpm', ['exec', 'vite', 'build'], { stdio: 'inherit', env: deployEnv }],
      ['pnpm', ['exec', 'cf', 'deploy', '--prebuilt'], { stdio: 'inherit', env: deployEnv }],
    ]);
  });

  it('refuses a build output that does not carry the released commit and OAuth ID', () => {
    expect(() => verifyBuiltDeployVars('oauth-client-id', commitSha, readBuiltConfig)).not.toThrow();
    expect(() =>
      verifyBuiltDeployVars(
        'oauth-client-id',
        commitSha,
        builtConfig({ CLOUDFLARE_OAUTH_CLIENT_ID: 'oauth-client-id' }),
      ),
    ).toThrow(`${BUILT_WORKER_CONFIG_PATH} must bind COMMIT_SHA to ${commitSha}; found undefined.`);
    expect(() =>
      verifyBuiltDeployVars(
        'oauth-client-id',
        commitSha,
        builtConfig({ COMMIT_SHA: commitSha, CLOUDFLARE_OAUTH_CLIENT_ID: 'other' }),
      ),
    ).toThrow(`${BUILT_WORKER_CONFIG_PATH} must bind CLOUDFLARE_OAUTH_CLIENT_ID to the deploy environment's value.`);

    const spawn = vi.fn(() => ({ status: 0 }));
    expect(() =>
      deployProduction({
        clientId: 'oauth-client-id',
        commitSha,
        env: workersBuildEnv,
        spawn,
        readBuiltConfig: builtConfig({}),
      }),
    ).toThrow('must bind COMMIT_SHA');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('verifies the deployment against the deployed commit', async () => {
    const verifyLocal = vi.fn(async () => undefined);

    await expect(
      deployAndVerifyProduction({
        clientId: 'oauth-client-id',
        commitSha,
        env: workersBuildEnv,
        spawn: () => ({ status: 0 }),
        readBuiltConfig,
        verifyLocal,
      }),
    ).resolves.toBe(commitSha);
    expect(verifyLocal).toHaveBeenCalledWith({ expectedSha: commitSha });
  });

  describe('Workers Builds deploy step', () => {
    /**
     * A clean checkout at the build's commit, and every pnpm step succeeding except `failStep`.
     * `onStep` lets a test finish the build at a chosen point.
     */
    function workersBuildSpawn(events: string[], { failStep = '', onStep = (_step: string) => {} } = {}) {
      return vi.fn((command: string, args: readonly string[]) => {
        if (command === 'git') {
          return { status: 0, stdout: args.includes('rev-parse') ? `${commitSha}\n` : '', stderr: '' };
        }
        const step = args[0] === 'run' ? (args[1] ?? '') : args.slice(1).join(' ');
        events.push(step);
        onStep(step);
        return { status: step === failStep ? 1 : 0 };
      });
    }

    function deferredBuild(events: string[], status = 0) {
      const build = { finish: () => {} };
      const spawnBuild = vi.fn(
        () =>
          new Promise<{ status: number; output: string }>((resolve) => {
            events.push('build started');
            build.finish = () => {
              events.push('build finished');
              resolve({ status, output: 'vite output\n' });
            };
          }),
      );
      return { spawnBuild, build };
    }

    it('builds while the checks and migrations run, and deploys only after both', async () => {
      const events: string[] = [];
      const { spawnBuild, build } = deferredBuild(events);
      const verifyLocal = vi.fn(async () => undefined);
      const log = vi.fn();
      const spawn = workersBuildSpawn(events, {
        onStep: (step) => {
          if (step === 'd1:migrations:apply:production') {
            build.finish();
          }
        },
      });

      await expect(
        deployFromWorkersBuilds({
          clientId: 'oauth-client-id',
          env: workersBuildEnv,
          spawn,
          spawnBuild,
          readBuiltConfig,
          verifyLocal,
          log,
        }),
      ).resolves.toBe(commitSha);

      expect(events).toEqual([
        'build started',
        ...WORKERS_BUILDS_PRE_DEPLOY_STEPS,
        'build finished',
        'cf deploy --prebuilt',
      ]);
      expect(spawnBuild).toHaveBeenCalledWith('pnpm', ['exec', 'vite', 'build'], {
        env: { ...workersBuildEnv, COMMIT_SHA: commitSha, CLOUDFLARE_OAUTH_CLIENT_ID: 'oauth-client-id' },
      });
      expect(log).toHaveBeenCalledWith('vite output\n');
      expect(verifyLocal).toHaveBeenCalledWith({ expectedSha: commitSha });
    });

    it('deploys nothing when a check or migration fails, and waits for the build first', async () => {
      const events: string[] = [];
      const { spawnBuild, build } = deferredBuild(events);
      const verifyLocal = vi.fn(async () => undefined);
      const deploy = deployFromWorkersBuilds({
        clientId: 'oauth-client-id',
        env: workersBuildEnv,
        spawn: workersBuildSpawn(events, { failStep: 'd1:migrations:apply:production' }),
        spawnBuild,
        readBuiltConfig,
        verifyLocal,
        log: vi.fn(),
      });
      build.finish();

      await expect(deploy).rejects.toThrow(
        'd1:migrations:apply:production failed with exit status 1. Nothing was deployed.',
      );
      expect(events).not.toContain('cf deploy --prebuilt');
      expect(events.at(-1)).toBe('build finished');
      expect(verifyLocal).not.toHaveBeenCalled();
    });

    it('deploys nothing when the build fails, even after every check passed', async () => {
      const events: string[] = [];
      const { spawnBuild, build } = deferredBuild(events, 1);
      const deploy = deployFromWorkersBuilds({
        clientId: 'oauth-client-id',
        env: workersBuildEnv,
        spawn: workersBuildSpawn(events),
        spawnBuild,
        readBuiltConfig,
        verifyLocal: vi.fn(async () => undefined),
        log: vi.fn(),
      });
      build.finish();

      await expect(deploy).rejects.toThrow('Vite build failed with exit status 1.');
      expect(events).not.toContain('cf deploy --prebuilt');
    });
  });

  it('propagates process failures', () => {
    expect(() =>
      deployProduction({
        clientId: 'oauth-client-id',
        commitSha,
        env: workersBuildEnv,
        spawn: () => ({ error: new Error('spawn failed') }),
      }),
    ).toThrow('spawn failed');
    expect(() =>
      deployProduction({
        clientId: 'oauth-client-id',
        commitSha,
        env: workersBuildEnv,
        spawn: () => ({ status: null }),
      }),
    ).toThrow('Vite build terminated without an exit status.');
    expect(() =>
      deployProduction({
        clientId: 'oauth-client-id',
        commitSha,
        env: workersBuildEnv,
        spawn: () => ({ status: 23 }),
      }),
    ).toThrow('Vite build failed with exit status 23. Live verification was not run.');
    const deployFails = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 23 });
    expect(() =>
      deployProduction({
        clientId: 'oauth-client-id',
        commitSha,
        env: workersBuildEnv,
        spawn: deployFails,
        readBuiltConfig,
      }),
    ).toThrow('cf deploy failed with exit status 23. Live verification was not run.');
  });
});
