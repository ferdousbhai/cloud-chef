import { describe, expect, it } from 'vitest';
import { D1MigrationChangedError } from '../../app/lib/.server/cloudflare/user-account-api';
import { appBuildPlan, appWorkerName, isAppCommit } from '../../app/lib/.server/cloudflare/project-build-plan';
import {
  agentRemovalRefusal,
  appMigrationFiles,
  appProfile,
  appResourceNames,
  migrationChangedMessage,
  trustedAppWranglerConfig,
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
