import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  checkWorkersBuildInputs,
  deployFromWorkersBuilds,
  findUnexpectedDeployChanges,
  latestControlPlaneMigration,
  migratedD1Note,
  PARTIALLY_MIGRATED_D1_NOTE,
  resolveCurrentCommitSha,
  resolveDeployableCommitSha,
  validateCommitSha,
  validateOAuthClientId,
  validateWorkersBuildContext,
  validateWorkersBuildMetadata,
  verifyBuiltDeployVars,
  BUILT_WORKER_CONFIG_PATH,
  WORKERS_BUILDS_AFTER_VALIDATION_STEPS,
  WORKERS_BUILDS_PRE_DEPLOY_STEPS,
} from './deploy-production.mjs';
import { VALIDATION_TASKS } from './validate.mjs';

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
      'd1:bookmark:production',
      'd1:migrations:apply:production',
    ]);
    // The committed-config checks run once, inside the validation every migration and deploy waits for.
    expect(WORKERS_BUILDS_PRE_DEPLOY_STEPS).not.toContain('verify:production-config');
    expect(WORKERS_BUILDS_PRE_DEPLOY_STEPS).not.toContain('verify:workers-builds-config');
    expect(VALIDATION_TASKS.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['verify:production-config', 'verify:workers-builds-config']),
    );
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

  describe('Workers Builds build step check', () => {
    const branchEnv = { ...workersBuildEnv, WORKERS_CI_BRANCH: 'next' };
    const head = { status: 0, stdout: `${commitSha}\n`, stderr: '' };
    const empty = { status: 0, stdout: '', stderr: '' };
    const spawns: ReturnType<typeof vi.fn>[] = [];
    function checkout(...results: (typeof head)[]) {
      const spawn = vi.fn();
      for (const result of results) {
        spawn.mockReturnValueOnce(result);
      }
      spawns.push(spawn);
      // SAFETY: these checks only call `git` synchronously and read `error`, `status`, `stdout` and `stderr`.
      return spawn as never;
    }
    const lastSpawn = () => spawns[spawns.length - 1];

    it('passes a branch build, which deploys nothing, without requiring main', () => {
      expect(
        checkWorkersBuildInputs({ clientId: 'oauth-client-id', env: branchEnv, spawn: checkout(head, empty, empty) }),
      ).toBe(commitSha);
      expect(lastSpawn()).toHaveBeenCalledTimes(3);
    });

    it('still checks a branch build for its identity, a clean checkout, and the OAuth client id', () => {
      expect(() =>
        checkWorkersBuildInputs({
          clientId: 'oauth-client-id',
          env: { ...branchEnv, WORKERS_CI_COMMIT_SHA: 'b'.repeat(40) },
          spawn: checkout(head, empty, empty),
        }),
      ).toThrow('does not match the checked-out commit');
      expect(() =>
        checkWorkersBuildInputs({
          clientId: 'oauth-client-id',
          env: branchEnv,
          spawn: checkout(head, { status: 0, stdout: ' M app/server.ts\n', stderr: '' }),
        }),
      ).toThrow('requires a clean Git worktree');
      expect(() =>
        checkWorkersBuildInputs({ clientId: '', env: branchEnv, spawn: checkout(head, empty, empty) }),
      ).toThrow('CLOUDFLARE_OAUTH_CLIENT_ID must be configured');
    });

    it('checks a main build exactly as the production deploy resolves its commit', () => {
      expect(
        checkWorkersBuildInputs({
          clientId: 'oauth-client-id',
          env: workersBuildEnv,
          spawn: checkout(head, empty, empty),
        }),
      ).toBe(commitSha);
      expect(lastSpawn()).toHaveBeenCalledTimes(3);
      expect(() =>
        checkWorkersBuildInputs({
          clientId: 'oauth-client-id',
          env: { ...workersBuildEnv, WORKERS_CI_BUILD_UUID: 'not-a-uuid' },
          spawn: checkout(head, empty, empty),
        }),
      ).toThrow('must be a lowercase UUID');
    });

    it('leaves every production deploy path refusing a branch build', async () => {
      expect(() => resolveDeployableCommitSha({ spawn: checkout(head, empty, empty), env: branchEnv })).toThrow(
        'Cloudflare production deploy requires the main branch; found next.',
      );
      const deploySpawn = checkout(head, empty, empty);
      const spawnValidation = vi.fn();
      await expect(
        deployFromWorkersBuilds({
          clientId: 'oauth-client-id',
          env: branchEnv,
          spawn: deploySpawn,
          spawnValidation,
        }),
      ).rejects.toThrow('requires the main branch');
      expect(spawnValidation).not.toHaveBeenCalled();
      expect(deploySpawn).toHaveBeenCalledTimes(1);
    });
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
  });

  describe('Workers Builds deploy step', () => {
    /**
     * A clean checkout at the build's commit, and every pnpm step succeeding except `failStep`.
     * `onStep` lets a test finish the build at a chosen point.
     */
    function workersBuildSpawn(events: string[], { failStep = '', onStep = (_step: string): void => undefined } = {}) {
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

    function deferredValidation(events: string[], status = 0) {
      const validation = { finish: (): void => undefined };
      const spawnValidation = vi.fn(
        () =>
          new Promise<{ status: number; output: string }>((resolve) => {
            events.push('validation started');
            validation.finish = () => {
              events.push('validation finished');
              resolve({ status, output: 'validate output\n' });
            };
          }),
      );
      return { spawnValidation, validation };
    }

    const accountChecks = WORKERS_BUILDS_PRE_DEPLOY_STEPS.filter(
      (step) => !WORKERS_BUILDS_AFTER_VALIDATION_STEPS.includes(step),
    );

    it('validates while the account checks run, migrates only after validation, and deploys its build', async () => {
      const events: string[] = [];
      const { spawnValidation, validation } = deferredValidation(events);
      const verifyLocal = vi.fn(async () => undefined);
      const log = vi.fn();
      const spawn = workersBuildSpawn(events, {
        onStep: (step) => {
          if (step === accountChecks.at(-1)) {
            queueMicrotask(() => validation.finish());
          }
        },
      });

      await expect(
        deployFromWorkersBuilds({
          clientId: 'oauth-client-id',
          env: workersBuildEnv,
          spawn,
          spawnValidation,
          readBuiltConfig,
          verifyLocal,
          log,
        }),
      ).resolves.toBe(commitSha);

      expect(events).toEqual([
        'validation started',
        ...accountChecks,
        'validation finished',
        ...WORKERS_BUILDS_AFTER_VALIDATION_STEPS,
        'cf deploy --prebuilt',
      ]);
      expect(WORKERS_BUILDS_AFTER_VALIDATION_STEPS).toEqual([
        'd1:bookmark:production',
        'd1:migrations:apply:production',
      ]);
      // Validation's `build:check` is the release build, so it runs with the release's deploy vars.
      expect(spawnValidation).toHaveBeenCalledWith('pnpm', ['run', 'validate'], {
        env: { ...workersBuildEnv, COMMIT_SHA: commitSha, CLOUDFLARE_OAUTH_CLIENT_ID: 'oauth-client-id' },
      });
      expect(log).toHaveBeenCalledWith('validate output\n');
      expect(verifyLocal).toHaveBeenCalledWith({ expectedSha: commitSha });
    });

    it('migrates and deploys nothing when validation fails', async () => {
      const events: string[] = [];
      const { spawnValidation, validation } = deferredValidation(events, 1);
      const log = vi.fn();
      const deploy = deployFromWorkersBuilds({
        clientId: 'oauth-client-id',
        env: workersBuildEnv,
        spawn: workersBuildSpawn(events),
        spawnValidation,
        readBuiltConfig,
        verifyLocal: vi.fn(async () => undefined),
        log,
      });
      validation.finish();

      await expect(deploy).rejects.toThrow(
        'Validation failed with exit status 1. Nothing was deployed. Nothing was migrated.',
      );
      expect(events).toEqual(['validation started', ...accountChecks, 'validation finished']);
      expect(log).toHaveBeenCalledWith('validate output\n');
    });

    it('migrates and deploys nothing when validation cannot start', async () => {
      const events: string[] = [];
      const deploy = deployFromWorkersBuilds({
        clientId: 'oauth-client-id',
        env: workersBuildEnv,
        spawn: workersBuildSpawn(events),
        spawnValidation: vi.fn(async () => {
          throw new Error('spawn pnpm ENOENT');
        }),
        readBuiltConfig,
        verifyLocal: vi.fn(async () => undefined),
        log: vi.fn(),
      });

      await expect(deploy).rejects.toThrow('spawn pnpm ENOENT');
      expect(events).toEqual(accountChecks);
    });

    it('deploys nothing when a check or migration fails, and waits for validation first', async () => {
      const events: string[] = [];
      const { spawnValidation, validation } = deferredValidation(events);
      const verifyLocal = vi.fn(async () => undefined);
      const log = vi.fn();
      const deploy = deployFromWorkersBuilds({
        clientId: 'oauth-client-id',
        env: workersBuildEnv,
        spawn: workersBuildSpawn(events, { failStep: 'd1:migrations:apply:production' }),
        spawnValidation,
        readBuiltConfig,
        verifyLocal,
        log,
      });
      validation.finish();

      await expect(deploy).rejects.toThrow(
        `d1:migrations:apply:production failed with exit status 1. Nothing was deployed.${PARTIALLY_MIGRATED_D1_NOTE}`,
      );
      expect(PARTIALLY_MIGRATED_D1_NOTE).toContain('may be partially migrated');
      expect(PARTIALLY_MIGRATED_D1_NOTE).toContain('Pre-migration D1 restore point');
      expect(events).not.toContain('cf deploy --prebuilt');
      expect(verifyLocal).not.toHaveBeenCalled();

      const failedCheckEvents: string[] = [];
      const failedCheck = deferredValidation(failedCheckEvents);
      const checkFails = deployFromWorkersBuilds({
        clientId: 'oauth-client-id',
        env: workersBuildEnv,
        spawn: workersBuildSpawn(failedCheckEvents, { failStep: 'provision:production:check' }),
        spawnValidation: failedCheck.spawnValidation,
        readBuiltConfig,
        verifyLocal,
        log,
      });
      setTimeout(() => failedCheck.validation.finish(), 0);

      await expect(checkFails).rejects.toThrow('provision:production:check failed with exit status 1.');
      // It waited for validation, so the build log holds its output, and migrated nothing.
      expect(failedCheckEvents).toEqual(['validation started', 'provision:production:check', 'validation finished']);
    });

    it('deploys nothing, and says D1 was migrated, when the validated build does not carry the release vars', async () => {
      const events: string[] = [];
      const { spawnValidation, validation } = deferredValidation(events);
      const deploy = deployFromWorkersBuilds({
        clientId: 'oauth-client-id',
        env: workersBuildEnv,
        spawn: workersBuildSpawn(events),
        spawnValidation,
        readBuiltConfig: builtConfig({ COMMIT_SHA: 'b'.repeat(40), CLOUDFLARE_OAUTH_CLIENT_ID: 'oauth-client-id' }),
        verifyLocal: vi.fn(async () => undefined),
        log: vi.fn(),
        latestMigration: () => '0042_example.sql',
      });
      validation.finish();

      await expect(deploy).rejects.toThrow(`must bind COMMIT_SHA to ${commitSha}`);
      await expect(deploy).rejects.toThrow(migratedD1Note('0042_example.sql'));
      expect(events).toContain('d1:migrations:apply:production');
      expect(events).not.toContain('cf deploy --prebuilt');
    });

    it('says D1 was already migrated, and through which migration, when cf deploy fails', async () => {
      const events: string[] = [];
      const { spawnValidation, validation } = deferredValidation(events);
      const verifyLocal = vi.fn(async () => undefined);
      const deploy = deployFromWorkersBuilds({
        clientId: 'oauth-client-id',
        env: workersBuildEnv,
        spawn: workersBuildSpawn(events, { failStep: 'cf deploy --prebuilt' }),
        spawnValidation,
        readBuiltConfig,
        verifyLocal,
        log: vi.fn(),
        latestMigration: () => '0042_example.sql',
      });
      validation.finish();

      await expect(deploy).rejects.toThrow(
        'cf deploy failed with exit status 1. Live verification was not run. Control-plane D1 was already migrated through 0042_example.sql;',
      );
      await expect(deploy).rejects.toThrow('Pre-migration D1 restore point');
      expect(verifyLocal).not.toHaveBeenCalled();
    });

    it('says D1 was already migrated when the live probe fails after the deploy', async () => {
      const events: string[] = [];
      const { spawnValidation, validation } = deferredValidation(events);
      const deploy = deployFromWorkersBuilds({
        clientId: 'oauth-client-id',
        env: workersBuildEnv,
        spawn: workersBuildSpawn(events),
        spawnValidation,
        readBuiltConfig,
        verifyLocal: vi.fn(async () => {
          throw new Error('https://cloudchef.build/api/version never reported the release.');
        }),
        log: vi.fn(),
        latestMigration: () => null,
      });
      validation.finish();

      await expect(deploy).rejects.toThrow(
        'https://cloudchef.build/api/version never reported the release. Control-plane D1 was already migrated;',
      );
      expect(events).toContain('cf deploy --prebuilt');
    });
  });

  it('names the newest checked-in control-plane migration as the last one applied', () => {
    expect(latestControlPlaneMigration(() => ['0002_b.sql', 'README', '0010_c.sql', '0001_a.sql'])).toBe('0010_c.sql');
    expect(latestControlPlaneMigration(() => [])).toBeNull();
    expect(latestControlPlaneMigration()).toMatch(/^\d{4}_.+\.sql$/);
  });
});
