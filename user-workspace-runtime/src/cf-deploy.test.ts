import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cfBuiltCommand,
  cfBuiltWorker,
  cfInstallLine,
  cfMigrationsArgs,
  cfPublishArgs,
  namedWorkerConfig,
  publishedAddress,
  publishedAddressReads,
  publishFolderCommand,
  writeWorkerConfigCommand,
  type SealedWorkerConfig,
} from './cf-deploy';

const DATABASE = 'e6481118-99df-4baa-8e6b-10076e04679b';
const workerDir = (version: string) => `.cloudflare/output/${version}/workers/default`;

/** What `cf build` leaves for a site with a database, its own Durable Object, two domains and a route. */
const BUILT = {
  name: 'example-site',
  compatibilityDate: '2026-10-01',
  domains: ['example.com', 'www.example.com'],
  triggers: [
    { type: 'fetch', pattern: 'example.com/api/*' },
    { type: 'scheduled', schedule: '0 3 * * *' },
  ],
  workersDev: false,
  exports: { Room: { type: 'durable-object', storage: 'sqlite' } },
  env: {
    DB: { type: 'd1', name: 'example', id: DATABASE },
    Room: { type: 'durable-object', worker: 'example-site', exportName: 'Room' },
    Billing: { type: 'worker', worker: 'billing' },
    CONTENT_BUCKET: { type: 'r2', name: 'example-content' },
  },
  manifest: { type: 'partial', mainModule: 'index.js', modules: {} },
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cloudchef-cf-deploy-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A builder command, with a folder of the test's standing in for the container's work and publish folders. */
function run(command: string) {
  const here = command.replaceAll('/opt/cloudchef/publish', `${root}/publish`).replaceAll('/work/', `${root}/work/`);
  const ran = spawnSync('bash', ['-c', here], { encoding: 'utf8' });
  expect(ran.stderr).toBe('');
  expect(ran.status).toBe(0);
  return ran.stdout;
}

function built(version = 'v1', config: SealedWorkerConfig = BUILT) {
  write(`work/${workerDir(version)}/worker.config.json`, JSON.stringify(config));
  write(`work/${workerDir(version)}/bundle/index.js`, 'export default {};');
  write(`work/${workerDir(version)}/assets/index.html`, '<h1>Example</h1>');
  write(`work/.cloudflare/output/${version}/config.json`, '{"buildContext":{"isPreview":false,"mode":"production"}}');
}

describe("a cf project's build, sealed for cf", () => {
  it('keeps the settings the build left, without the domains and routes a publish never changes', () => {
    built();
    write('work/migrations/0001_init.sql', 'create table t (id integer);');
    const sealed = cfBuiltWorker(run(cfBuiltCommand()));
    if ('reason' in sealed) {
      throw new Error(sealed.reason);
    }
    expect(sealed.config).not.toHaveProperty('domains');
    expect(sealed.config.triggers).toEqual([{ type: 'scheduled', schedule: '0 3 * * *' }]);
    expect(sealed.config).toMatchObject({
      name: 'example-site',
      compatibilityDate: '2026-10-01',
      workersDev: false,
      exports: BUILT.exports,
      env: BUILT.env,
      manifest: BUILT.manifest,
    });
    expect(sealed.workerName).toBe('example-site');
    expect(sealed.version).toBe('v1');
    expect(sealed.notes.join(' ')).toContain('domains and routes');
  });

  it('applies the migrations folder to its one database, by the id cf names a database with', () => {
    built();
    write('work/migrations/0001_init.sql', 'create table t (id integer);');
    const sealed = cfBuiltWorker(run(cfBuiltCommand()));
    expect(sealed).toMatchObject({ migrations: [{ binding: 'DB', databaseName: 'example', databaseId: DATABASE }] });
    expect(cfMigrationsArgs(DATABASE)).toBe(`d1 migrations apply ${DATABASE} --dir '/work/migrations'`);
    // A name is not an id: cf takes none, and neither does this.
    expect(() => cfMigrationsArgs('example')).toThrow();
    expect(() => cfMigrationsArgs(`${DATABASE} --dir /etc`)).toThrow();
  });

  it('applies no migrations without the folder, with two databases, or with a database that has no id', () => {
    built();
    expect(cfBuiltWorker(run(cfBuiltCommand()))).toMatchObject({ migrations: [], notes: [expect.any(String)] });
    const two = { ...BUILT, domains: [], triggers: [], env: { ...BUILT.env, OTHER: { type: 'd1', id: DATABASE } } };
    built('v1', two);
    write('work/migrations/0001_init.sql', 'create table t (id integer);');
    const sealed = cfBuiltWorker(run(cfBuiltCommand()));
    expect(sealed).toMatchObject({ migrations: [] });
    expect('notes' in sealed ? sealed.notes.join(' ') : '').toContain('exactly one D1 database');
    built('v1', { ...BUILT, env: { DB: { type: 'd1', name: 'example' } } });
    expect(cfBuiltWorker(run(cfBuiltCommand()))).toMatchObject({ migrations: [] });
  });

  it('says why a build with no Worker, two versions, several Workers or unreadable settings is not published', () => {
    mkdirSync(join(root, 'work'), { recursive: true });
    expect(cfBuiltWorker(run(cfBuiltCommand()))).toMatchObject({ stage: 'build' });
    built('v1');
    built('v0');
    expect(cfBuiltWorker(run(cfBuiltCommand()))).toMatchObject({ stage: 'config' });
    rmSync(join(root, 'work/.cloudflare/output/v0'), { recursive: true });
    write('work/.cloudflare/output/v1/workers/other/worker.config.json', '{}');
    expect(cfBuiltWorker(run(cfBuiltCommand()))).toMatchObject({ reason: expect.stringContaining('more than one') });
    rmSync(join(root, 'work/.cloudflare/output/v1/workers/other'), { recursive: true });
    built('v1', { ...BUILT, name: 'Not A Name' });
    expect(cfBuiltWorker(run(cfBuiltCommand()))).toMatchObject({ reason: expect.stringContaining('needs a name') });
    write(`work/${workerDir('v1')}/worker.config.json`, '{ not json');
    expect(cfBuiltWorker(run(cfBuiltCommand()))).toMatchObject({ stage: 'config' });
  });
});

describe('the folder cf publishes from', () => {
  it.each(['v1', 'v0'] as const)('holds the built Worker as v1 and nothing else of the project (%s)', (version) => {
    built(version);
    write('work/package.json', '{"dependencies":{"cf":"1.0.0-rc.6"}}');
    write('work/node_modules/cf/package.json', '{"name":"cf","bin":{"cf":"bin/cf"}}');
    write('work/cloudflare.config.ts', 'export default {};');
    write('work/.wrangler/deploy/config.json', '{"configPath":"../../wrangler.json"}');
    run(publishFolderCommand(version, { name: 'example-site', manifest: BUILT.manifest }));
    expect(existsSync(join(root, `work/.cloudflare/output/${version}`))).toBe(false);
    expect(existsSync(join(root, 'work/.wrangler/deploy'))).toBe(false);
    expect(run(`cd /opt/cloudchef/publish && find . -type f | sort`).trim().split('\n')).toEqual([
      './.cloudflare/output/v1/config.json',
      './.cloudflare/output/v1/workers/default/assets/index.html',
      './.cloudflare/output/v1/workers/default/bundle/index.js',
      './.cloudflare/output/v1/workers/default/worker.config.json',
    ]);
    expect(JSON.parse(readFileSync(join(root, 'publish/.cloudflare/output/v1/config.json'), 'utf8'))).toEqual({
      producer: { name: 'cloudchef', version: '1' },
      buildContext: { isPreview: false, mode: 'production' },
    });
    expect(JSON.parse(readFileSync(join(root, `publish/${workerDir('v1')}/worker.config.json`), 'utf8'))).toEqual({
      name: 'example-site',
      manifest: BUILT.manifest,
    });
  });

  it('is emptied of an earlier publish, and takes new settings whole', () => {
    built();
    write('publish/leftover.txt', 'from the last publish');
    run(publishFolderCommand('v1'));
    expect(existsSync(join(root, 'publish/leftover.txt'))).toBe(false);
    // Without settings of CloudChef's, the build's own are still there until the app's are written.
    expect(JSON.parse(readFileSync(join(root, `publish/${workerDir('v1')}/worker.config.json`), 'utf8'))).toEqual(
      BUILT,
    );
    run(writeWorkerConfigCommand({ name: 'tip-calc', note: 'it’s “quoted” $HOME `x`' }));
    expect(JSON.parse(readFileSync(join(root, `publish/${workerDir('v1')}/worker.config.json`), 'utf8'))).toEqual({
      name: 'tip-calc',
      note: 'it’s “quoted” $HOME `x`',
    });
  });
});

describe('the name a sealed Worker is published under', () => {
  it('is the project’s Worker, whatever the config calls it, and its own bindings follow it', () => {
    const named = namedWorkerConfig(JSON.stringify(BUILT), 'example-site-a1b2c3');
    expect(named).toMatchObject({
      name: 'example-site-a1b2c3',
      compatibilityDate: '2026-10-01',
      env: {
        DB: BUILT.env.DB,
        Room: { type: 'durable-object', worker: 'example-site-a1b2c3', exportName: 'Room' },
        // Another Worker's stays another Worker's.
        Billing: { type: 'worker', worker: 'billing' },
      },
    });
    expect(named).not.toHaveProperty('domains');
  });

  it('leaves settings already under that name as they are, and reads nothing that is not settings', () => {
    const { domains: _domains, ...rest } = BUILT;
    expect(namedWorkerConfig(JSON.stringify(BUILT), 'example-site')).toEqual(rest);
    expect(namedWorkerConfig('{ not json', 'example-site')).toBeUndefined();
    expect(namedWorkerConfig('[]', 'example-site')).toBeUndefined();
  });
});

describe('what cf is asked to do', () => {
  it('publishes the sealed Worker without making resources, or uploads a version under the branch’s alias', () => {
    expect(cfPublishArgs('production', 'ignored')).toBe('deploy --prebuilt --provision=false');
    expect(cfPublishArgs('preview', 'new-header')).toBe(
      "workers versions create --prebuilt --preview-alias 'new-header'",
    );
  });

  it('is CloudChef’s own pinned copy, installed without running its scripts', () => {
    expect(cfInstallLine()).toContain('npm install --prefix /opt/cloudchef/cf cf@1.0.0-rc.6 --ignore-scripts');
  });
});

describe('where a publish is served, as Cloudflare’s API says', () => {
  const subdomain = { result: { subdomain: 'example' }, success: true };
  const version = (alias: string | undefined, hasPreview: boolean) => ({
    id: crypto.randomUUID(),
    metadata: { has_preview: hasPreview },
    annotations: alias ? { 'workers/alias': alias } : {},
  });

  it('asks only for the Worker’s own addresses', () => {
    expect(publishedAddressReads('production', 'glossary')).toEqual({
      subdomain: '/workers/subdomain',
      workerSubdomain: '/workers/scripts/glossary/subdomain',
      domains: '/workers/domains?service=glossary',
    });
    expect(publishedAddressReads('preview', 'glossary')).toEqual({
      subdomain: '/workers/subdomain',
      versions: '/workers/scripts/glossary/versions?per_page=10',
    });
  });

  it('is the workers.dev address of a Worker that has one', () => {
    expect(
      publishedAddress({
        kind: 'production',
        workerName: 'glossary',
        alias: 'main',
        answers: {
          subdomain,
          workerSubdomain: { result: { enabled: true, previews_enabled: true } },
          domains: { result: [{ hostname: 'glossary.example.com' }] },
        },
      }),
    ).toBe('https://glossary.example.workers.dev');
  });

  it('is the first custom domain of a Worker without workers.dev, and none when it has neither', () => {
    const answers = { subdomain, workerSubdomain: { result: { enabled: false, previews_enabled: false } } };
    expect(
      publishedAddress({
        kind: 'production',
        workerName: 'glossary',
        alias: 'main',
        answers: { ...answers, domains: { result: [{ hostname: 'glossary.example.com' }, { hostname: 'b.example' }] } },
      }),
    ).toBe('https://glossary.example.com');
    expect(
      publishedAddress({
        kind: 'production',
        workerName: 'glossary',
        alias: 'main',
        answers: { ...answers, domains: { result: [] } },
      }),
    ).toBeNull();
    expect(publishedAddress({ kind: 'production', workerName: 'glossary', alias: 'main', answers: {} })).toBeNull();
  });

  it('is the alias of the newest version uploaded with it, when that version has a preview', () => {
    const preview = (items: unknown[]) =>
      publishedAddress({
        kind: 'preview',
        workerName: 'glossary',
        alias: 'new-header',
        answers: { subdomain, versions: { result: { items } } },
      });
    expect(preview([version(undefined, true), version('new-header', true), version('new-header', false)])).toBe(
      'https://new-header-glossary.example.workers.dev',
    );
    // A Worker with Durable Objects has no previews; another branch's alias is not this one's.
    expect(preview([version('new-header', false), version('new-header', true)])).toBeNull();
    expect(preview([version('other', true)])).toBeNull();
    expect(preview([])).toBeNull();
    expect(
      publishedAddress({ kind: 'preview', workerName: 'glossary', alias: 'new-header', answers: { subdomain } }),
    ).toBeNull();
  });
});
