import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CF_CONFIG_VERSION, cfConvertCommand, cfProjectDeploy } from './cf-project-build';

/**
 * The convert step runs for real, with the system's shell and node and the repository's own copy of Cloudflare's
 * converter, against a folder standing in for the build container's work folder.
 */
const CONVERTER = fileURLToPath(import.meta.resolve('@cloudflare/config'));
const WORKER_DIR = '.cloudflare/output/v0/workers/default';

/** What `cf build` leaves for a site with a database, sessions, files, email, a rate limit and two domains. */
const BUILT = {
  name: 'example-site',
  compatibilityDate: '2026-10-01',
  compatibilityFlags: ['nodejs_compat'],
  domains: ['example.com', 'www.example.com'],
  observability: { enabled: true, redactQueryString: true },
  workersDev: false,
  previewUrls: false,
  env: {
    DB: { type: 'd1', name: 'example', id: 'e6481118-99df-4baa-8e6b-10076e04679b' },
    AUTH_KV: { type: 'kv', id: '3f6b7c901c994f849defc8b9a068e77c' },
    CONTENT_BUCKET: { type: 'r2', name: 'example-content' },
    EMAIL: { type: 'send-email', allowedSenderAddresses: ['contact@example.com'] },
    CONTACT_LIMIT: { type: 'rate-limit', namespace: '1001', simple: { limit: 3, period: 60 } },
  },
  manifest: { type: 'partial', mainModule: 'index.js', modules: {} },
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cloudchef-cf-project-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** Runs the convert step with `root` as the work folder, and reads what it comes to. */
function convert() {
  const command = cfConvertCommand(CONVERTER, null).replaceAll("'/work/", `'${root}/`);
  const ran = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
  expect(ran.stderr).toBe('');
  expect(ran.status).toBe(0);
  return cfProjectDeploy(ran.stdout);
}

describe("a cf project's deploy", () => {
  it('pins the converter the repository itself has', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(CONVERTER), '..', 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ version: CF_CONFIG_VERSION });
  });

  it('deploys the built Worker as it is, with its settings and assets, and leaves its domains alone', () => {
    write(`${WORKER_DIR}/worker.config.json`, JSON.stringify(BUILT));
    write(`${WORKER_DIR}/bundle/index.js`, 'export default {}');
    write(`${WORKER_DIR}/assets/favicon.ico`, '');
    write('migrations/0001_content.sql', '');
    expect(convert()).toEqual({
      workerName: 'example-site',
      migrations: [{ binding: 'DB', databaseName: 'example' }],
      notes: [expect.stringContaining('domains and routes in cloudflare.config.ts are not changed by publishing')],
      config: {
        name: 'example-site',
        main: `${WORKER_DIR}/bundle/index.js`,
        base_dir: `${WORKER_DIR}/bundle`,
        no_bundle: true,
        find_additional_modules: true,
        rules: [
          { type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] },
          { type: 'CompiledWasm', globs: ['**/*.wasm'] },
        ],
        assets: { directory: `${WORKER_DIR}/assets` },
        compatibility_date: '2026-10-01',
        compatibility_flags: ['nodejs_compat'],
        workers_dev: false,
        preview_urls: false,
        observability: { enabled: true, redact_query_string: true },
        d1_databases: [
          { binding: 'DB', database_id: 'e6481118-99df-4baa-8e6b-10076e04679b', database_name: 'example' },
        ],
        kv_namespaces: [{ binding: 'AUTH_KV', id: '3f6b7c901c994f849defc8b9a068e77c' }],
        r2_buckets: [{ binding: 'CONTENT_BUCKET', bucket_name: 'example-content' }],
        send_email: [{ name: 'EMAIL', allowed_sender_addresses: ['contact@example.com'] }],
        ratelimits: [{ name: 'CONTACT_LIMIT', namespace_id: '1001', simple: { limit: 3, period: 60 } }],
      },
    });
  });

  it('applies no migrations without a migrations folder, and keeps the assets settings of a Worker that has them', () => {
    const { domains: _domains, ...withoutDomains } = BUILT;
    write(
      `${WORKER_DIR}/worker.config.json`,
      JSON.stringify({
        ...withoutDomains,
        assets: { runWorkerFirst: ['/api/*'] },
        env: { ASSETS: { type: 'assets' } },
      }),
    );
    write(`${WORKER_DIR}/assets/index.html`, '');
    const deploy = convert();
    expect(deploy).toMatchObject({
      migrations: [],
      notes: [],
      config: { assets: { binding: 'ASSETS', run_worker_first: ['/api/*'], directory: `${WORKER_DIR}/assets` } },
    });
  });

  it('says why a build that left no Worker, several, a container, or settings it cannot read is not published', () => {
    expect(convert()).toMatchObject({ stage: 'build', reason: expect.stringContaining('must run cf build') });
    write(`${WORKER_DIR}/worker.config.json`, JSON.stringify({ ...BUILT, name: 'Not A Name' }));
    expect(convert()).toMatchObject({ stage: 'config' });
    write(`${WORKER_DIR}/worker.config.json`, '{');
    expect(convert()).toMatchObject({ stage: 'config', reason: expect.stringContaining('it is not JSON') });
    write(`${WORKER_DIR}/worker.config.json`, JSON.stringify(BUILT));
    write('.cloudflare/output/v0/workers/other/worker.config.json', '{}');
    expect(convert()).toMatchObject({ stage: 'config', reason: expect.stringContaining('more than one Worker') });
  });

  it('leaves a folder of migrations unapplied when the project has several databases', () => {
    write(
      `${WORKER_DIR}/worker.config.json`,
      JSON.stringify({
        ...BUILT,
        env: { DB: BUILT.env.DB, OTHER: { type: 'd1', name: 'other', id: 'ef4b5c1f-aac5-4bee-8e97-82dd4e605c98' } },
      }),
    );
    write('migrations/0001_content.sql', '');
    expect(convert()).toMatchObject({
      migrations: [],
      notes: [expect.anything(), expect.stringContaining('exactly one D1 database')],
    });
  });
});
