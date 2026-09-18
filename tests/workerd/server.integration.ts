/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { exports, env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

type WorkerdTestEnv = {
  CLOUDFLARE_OAUTH_SCOPES: string;
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const rootWorker = exports as unknown as { default: Fetcher };
const testEnv = env as unknown as WorkerdTestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('root Worker in workerd', () => {
  it('dispatches the health route with application security headers', async () => {
    const response = await rootWorker.default.fetch('https://cloudchef.test/api/health');

    expect(response.status).toBe(200);
    expect(response.headers.has('Cross-Origin-Opener-Policy')).toBe(false);
    expect(response.headers.has('Cross-Origin-Embedder-Policy')).toBe(false);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expect(response.json()).resolves.toMatchObject({ status: 'healthy' });
  });

  it('enforces route methods and API cache policy', async () => {
    const response = await rootWorker.default.fetch('https://cloudchef.test/api/health', { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Method not allowed' });
  });

  it('loads only the root identity and Cloudflare connection bindings', async () => {
    const migration = await testEnv.DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{
      name: string;
    }>();
    expect(migration?.name).toBe(testEnv.TEST_MIGRATIONS.at(-1)?.name);

    expect(testEnv.CLOUDFLARE_OAUTH_SCOPES).toContain('workers-scripts.write');
  });

  it('exposes deployment metadata through the Worker entrypoint', async () => {
    const response = await rootWorker.default.fetch('https://cloudchef.test/api/version');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sha: 'workerd-test-sha',
      oauthConfigured: true,
    });
  });
});
