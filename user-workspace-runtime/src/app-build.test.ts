import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D1MigrationChangedError } from '../../app/lib/.server/cloudflare/user-account-api';
import { appBuildPlan, appWorkerName, isAppCommit } from '../../app/lib/.server/cloudflare/project-build-plan';
import {
  agentRemovalRefusal,
  appMigrationFiles,
  appBuiltVersion,
  appBuiltVersionCommand,
  appProfile,
  appResourceNames,
  migrationChangedMessage,
  trustedAppWorkerConfig,
  trustedAppWranglerConfig,
  versionDeclaresExports,
} from './app-build';

const STARTER = JSON.stringify({
  name: 'cloudchef-cloudflare-app',
  entrypoint: 'src/plain-server.ts',
  assets: true,
  d1: { name: 'cloudchef-cloudflare-app', id: '00000000-0000-0000-0000-000000000000' },
  kv: { id: '00000000000000000000000000000000' },
  r2: { name: 'cloudchef-cloudflare-app-storage' },
});
const AGENT = JSON.stringify({
  name: 'cloudchef-cloudflare-app',
  entrypoint: 'src/server.ts',
  agent: {
    securityD1: { name: 'cloudchef-cloudflare-app-agent-security', id: '00000000-0000-0000-0000-000000000000' },
  },
});
const PACKAGE = JSON.stringify({ packageManager: 'pnpm@11.14.0', scripts: { build: 'vite build' } });

describe('a CloudChef app built in app mode', () => {
  it('is a commit with CloudChef’s project file and no Wrangler config of its own', () => {
    expect(isAppCommit({ 'package.json': PACKAGE, 'cloudflare.project.json': STARTER })).toBe(true);
    expect(isAppCommit({ 'package.json': PACKAGE, 'cloudflare.project.json': STARTER, 'wrangler.jsonc': '{}' })).toBe(
      false,
    );
    expect(isAppCommit({ 'package.json': PACKAGE })).toBe(false);
  });

  it('reads the capabilities its project file declares, and builds with its own build script', () => {
    const read = appProfile({ projectFile: STARTER, packageJson: PACKAGE });
    expect(read).toEqual({
      profile: {
        type: 'web_app',
        bindings: { ai: false, d1: true, r2: true, kv: true, appAgent: false, assets: true },
      },
    });
    if (!('profile' in read)) {
      throw new Error('unreachable');
    }
    expect(
      appBuildPlan({ 'package.json': PACKAGE, 'pnpm-lock.yaml': '' }, read.profile, appWorkerName('Tip Calc!')),
    ).toEqual({
      deployable: true,
      packageManager: 'pnpm',
      install: 'pnpm install --frozen-lockfile',
      build: 'pnpm run build',
      configBuild: null,
      configFile: null,
      workerName: 'tip-calc',
      migrations: [],
      app: read.profile,
    });
    expect(appWorkerName(null)).toBe('app');
  });

  it('says what is wrong with a project file it can’t use', () => {
    expect(appProfile({ projectFile: '{ nope', packageJson: PACKAGE })).toMatchObject({
      reason: expect.stringContaining('cloudflare.project.json'),
    });
    expect(appProfile({ projectFile: STARTER, packageJson: '{"cloudchef":{"projectType":"site"}}' })).toMatchObject({
      reason: expect.stringContaining('projectType'),
    });
  });

  it('names its resources after its Worker and the project, never with CloudChef’s own names', async () => {
    const names = await appResourceNames('tip-calc', '6f1c0a9e-36f4-4b8a-9d0e-0a1b2c3d4e5f');
    expect(names.DB).toMatch(/^tip-calc-db-[0-9a-f]{6}$/);
    expect(names.AGENT_SECURITY_DB).toMatch(/^tip-calc-agent-[0-9a-f]{6}$/);
    expect(names.APP_STORAGE).toMatch(/^tip-calc-files-[0-9a-f]{6}$/);
    expect(names.APP_CACHE).toMatch(/^tip-calc-cache-[0-9a-f]{6}$/);
    expect(await appResourceNames('tip-calc', '6f1c0a9e-36f4-4b8a-9d0e-0a1b2c3d4e5f')).toEqual(names);
    expect((await appResourceNames('tip-calc', '00000000-36f4-4b8a-9d0e-0a1b2c3d4e5f')).DB).not.toBe(names.DB);
    await expect(appResourceNames('cloudchef-site', 'x')).rejects.toThrow('CloudChef');
  });

  it('deploys with CloudChef’s settings and the resources it made, whatever the project’s own config says', () => {
    const read = appProfile({ projectFile: AGENT, packageJson: '{"cloudchef":{"projectType":"worker"}}' });
    if (!('profile' in read)) {
      throw new Error(read.reason);
    }
    const config = trustedAppWranglerConfig({
      workerName: 'helper',
      profile: read.profile,
      resources: { AGENT_SECURITY_DB: { id: '11111111-1111-1111-1111-111111111111', name: 'helper-agent-abc123' } },
      buildOutput: 'v0',
    });
    expect(config).toMatchObject({
      name: 'helper',
      main: '.cloudflare/output/v0/workers/default/bundle/index.js',
      no_bundle: true,
      compatibility_flags: ['nodejs_compat'],
      workers_dev: true,
      d1_databases: [
        {
          binding: 'AGENT_SECURITY_DB',
          database_name: 'helper-agent-abc123',
          database_id: '11111111-1111-1111-1111-111111111111',
        },
      ],
      ai: { binding: 'AI' },
      durable_objects: { bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['AppAgent'] }],
      triggers: { crons: ['0 3 * * *'] },
    });
    expect(config).not.toHaveProperty('assets');
  });

  it('declares the Agent by exports once a publish with cf has, since Cloudflare then refuses migrations', () => {
    const read = appProfile({ projectFile: AGENT, packageJson: PACKAGE });
    if (!('profile' in read)) {
      throw new Error(read.reason);
    }
    const config = trustedAppWranglerConfig({
      workerName: 'helper',
      profile: read.profile,
      resources: {},
      buildOutput: 'v1',
      declaredExports: true,
    });
    expect(config.exports).toEqual({ AppAgent: { type: 'durable-object', storage: 'sqlite' } });
    expect(config).not.toHaveProperty('migrations');
    expect(config.durable_objects).toEqual({ bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] });
    const version = (runtime: { exports?: { AppAgent?: { type: string } }; migration_tag?: string }) =>
      JSON.stringify({ result: { resources: { script_runtime: runtime } } });
    expect(versionDeclaresExports(version({ exports: { AppAgent: { type: 'durable-object' } } }))).toBe(true);
    expect(versionDeclaresExports(version({ migration_tag: 'v1' }))).toBe(false);
    expect(versionDeclaresExports(version({ exports: {} }))).toBe(false);
    expect(versionDeclaresExports('{ not json')).toBe(false);
  });

  it('writes the settings cf publishes an app with: its resources by id, in cf’s own form', () => {
    const starter = appProfile({ projectFile: STARTER, packageJson: PACKAGE });
    const agent = appProfile({ projectFile: AGENT, packageJson: PACKAGE });
    if (!('profile' in starter) || !('profile' in agent)) {
      throw new Error('unreadable');
    }
    expect(
      trustedAppWorkerConfig({
        workerName: 'tip-calc',
        profile: starter.profile,
        resources: {
          DB: { id: '11111111-1111-1111-1111-111111111111', name: 'tip-calc-db-abc123' },
          APP_STORAGE: { name: 'tip-calc-files-abc123' },
          APP_CACHE: { id: '22222222222222222222222222222222' },
        },
      }),
    ).toEqual({
      name: 'tip-calc',
      compatibilityDate: '2026-07-21',
      compatibilityFlags: ['nodejs_compat'],
      workersDev: true,
      previewUrls: true,
      observability: {
        enabled: true,
        logs: { enabled: true, headSamplingRate: 0.6 },
        traces: { enabled: true, headSamplingRate: 0.05 },
      },
      assets: { runWorkerFirst: ['/*', '!/assets/*'] },
      env: {
        ASSETS: { type: 'assets' },
        DB: { type: 'd1', name: 'tip-calc-db-abc123', id: '11111111-1111-1111-1111-111111111111' },
        APP_STORAGE: { type: 'r2', name: 'tip-calc-files-abc123' },
        APP_CACHE: { type: 'kv', id: '22222222222222222222222222222222' },
      },
      manifest: { type: 'partial', mainModule: 'index.js', modules: {} },
    });
    const helper = trustedAppWorkerConfig({
      workerName: 'helper',
      profile: agent.profile,
      resources: { AGENT_SECURITY_DB: { id: '11111111-1111-1111-1111-111111111111', name: 'helper-agent-abc123' } },
    });
    expect(helper).toMatchObject({
      name: 'helper',
      env: {
        AGENT_SECURITY_DB: { type: 'd1', name: 'helper-agent-abc123', id: '11111111-1111-1111-1111-111111111111' },
        AI: { type: 'ai' },
        // The Agent is the Worker's own class, under the name it is published as.
        AppAgent: { type: 'durable-object', worker: 'helper', exportName: 'AppAgent' },
      },
      exports: { AppAgent: { type: 'durable-object', storage: 'sqlite' } },
      triggers: [{ type: 'scheduled', schedule: '0 3 * * *' }],
    });
    expect(helper).not.toHaveProperty('domains');
  });

  it('deploys the Worker from the Build Output version its build left, v1 or v0', () => {
    const read = appProfile({ projectFile: STARTER, packageJson: PACKAGE });
    if (!('profile' in read)) {
      throw new Error(read.reason);
    }
    const built = (buildOutput: 'v0' | 'v1') => {
      const { main, base_dir, assets, ...rest } = trustedAppWranglerConfig({
        workerName: 'tip-calc',
        profile: read.profile,
        resources: {},
        buildOutput,
      });
      return { main, base_dir, directory: assets?.directory, rest: { ...rest, assetsBinding: assets?.binding } };
    };
    expect(built('v1')).toMatchObject({
      main: '.cloudflare/output/v1/workers/default/bundle/index.js',
      base_dir: '.cloudflare/output/v1/workers/default/bundle',
      directory: '.cloudflare/output/v1/workers/default/assets',
    });
    expect(built('v0')).toMatchObject({
      main: '.cloudflare/output/v0/workers/default/bundle/index.js',
      base_dir: '.cloudflare/output/v0/workers/default/bundle',
      directory: '.cloudflare/output/v0/workers/default/assets',
    });
    // Nothing but the folder differs.
    expect(built('v1').rest).toEqual(built('v0').rest);
  });

  it('finds which version the build left its Worker in, and refuses none or both', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloudchef-app-build-'));
    const find = () => {
      const ran = spawnSync('bash', ['-c', appBuiltVersionCommand().replaceAll("'/work/", `'${root}/`)], {
        encoding: 'utf8',
      });
      expect(ran.status).toBe(0);
      return appBuiltVersion(ran.stdout);
    };
    const leave = (version: string) => {
      mkdirSync(join(root, `.cloudflare/output/${version}/workers/default/bundle`), { recursive: true });
      writeFileSync(join(root, `.cloudflare/output/${version}/workers/default/bundle/index.js`), '');
    };
    try {
      expect(find()).toMatchObject({ reason: expect.stringContaining('didn’t leave the app’s Worker') });
      leave('v1');
      expect(find()).toEqual({ version: 'v1' });
      leave('v0');
      expect(find()).toMatchObject({ reason: expect.stringContaining('more than one version') });
      rmSync(join(root, '.cloudflare/output/v1'), { recursive: true });
      expect(find()).toEqual({ version: 'v0' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies each database’s NNNN_name.sql migrations in order, only for the databases it has', () => {
    const files = [
      { path: 'migrations/0002_notes.sql', oid: 'b' },
      { path: 'migrations/0001_app_data.sql', oid: 'a' },
      { path: 'migrations/README.md', oid: 'c' },
      { path: 'migrations/old/0003_x.sql', oid: 'd' },
      { path: 'agent-security-migrations/0001_agent_security.sql', oid: 'e' },
    ];
    const web = { type: 'web_app' as const, bindings: { ai: false, d1: true, r2: false, kv: false, appAgent: false } };
    expect(appMigrationFiles(files, web)).toEqual({
      DB: [
        { name: '0001_app_data.sql', oid: 'a' },
        { name: '0002_notes.sql', oid: 'b' },
      ],
      AGENT_SECURITY_DB: [],
    });
  });

  it('refuses removing the Agent from a Worker holding its data, and explains a changed migration', () => {
    const plain = {
      type: 'web_app' as const,
      bindings: { ai: false, d1: true, r2: false, kv: false, appAgent: false },
    };
    expect(agentRemovalRefusal(plain, ['AppAgent'])).toContain('pnpm run agent:enable');
    expect(agentRemovalRefusal(plain, [])).toBeNull();
    expect(
      migrationChangedMessage(new D1MigrationChangedError('0002_notes.sql', 'CREATE TABLE notes (id INTEGER);')),
    ).toContain('It was applied as:\nCREATE TABLE notes (id INTEGER);');
  });
});
