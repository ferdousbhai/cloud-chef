import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'jsonc-parser';
import { describe, expect, test } from 'vitest';
import {
  cleanupExpiredAgentSecurityState,
  consumeAppAgentInferenceBudget,
  GLOBAL_DAILY_INFERENCE_LIMIT,
  GLOBAL_DAILY_SESSION_CREATION_LIMIT,
  handleAgentSessionBootstrap,
  resolveAgentSession,
} from '../template/src/agent-security';
import { enableAgentCapability } from '../template/scripts/enable-agent-capability.mjs';

describe('generated app agent security', () => {
  test('keeps the protected Agent capability available but disabled by default', () => {
    const config = parse(readFileSync('template/wrangler.jsonc', 'utf8'));
    const capability = JSON.parse(readFileSync('template/agent-capability.json', 'utf8'));

    expect(config.main).toBe('src/plain-server.ts');
    expect(config.ai).toBeUndefined();
    expect(config.durable_objects).toBeUndefined();
    expect(config.triggers).toBeUndefined();
    expect(config.d1_databases).toEqual([expect.objectContaining({ binding: 'DB', migrations_dir: 'migrations' })]);
    expect(capability).toMatchObject({
      wrangler: {
        main: 'src/server.ts',
        ai: { binding: 'AI' },
        agentSecurityDatabase: {
          binding: 'AGENT_SECURITY_DB',
          migrations_dir: 'agent-security-migrations',
        },
        durable_objects: { bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] },
        triggers: { crons: ['0 3 * * *'] },
      },
    });
  });

  test('enables the complete Agent capability idempotently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloudchef-agent-capability-'));
    try {
      for (const path of [
        'package.json',
        'wrangler.jsonc',
        'tsconfig.json',
        'agent-capability.json',
        'scripts/production-license-policy.json',
      ]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        cpSync(join('template', path), join(root, path));
      }

      await enableAgentCapability(root);
      const first = {
        package: readFileSync(join(root, 'package.json'), 'utf8'),
        licensePolicy: readFileSync(join(root, 'scripts/production-license-policy.json'), 'utf8'),
        wrangler: readFileSync(join(root, 'wrangler.jsonc'), 'utf8'),
        tsconfig: readFileSync(join(root, 'tsconfig.json'), 'utf8'),
      };
      await enableAgentCapability(root);
      expect({
        package: readFileSync(join(root, 'package.json'), 'utf8'),
        licensePolicy: readFileSync(join(root, 'scripts/production-license-policy.json'), 'utf8'),
        wrangler: readFileSync(join(root, 'wrangler.jsonc'), 'utf8'),
        tsconfig: readFileSync(join(root, 'tsconfig.json'), 'utf8'),
      }).toEqual(first);

      const pkg = JSON.parse(first.package);
      const licensePolicy = JSON.parse(first.licensePolicy);
      const config = parse(first.wrangler);
      const tsconfig = JSON.parse(first.tsconfig);
      expect(pkg.dependencies).toMatchObject({
        agents: '0.20.1',
        ai: '7.0.48',
        'core-js-pure': '3.49.0',
        partyserver: '0.5.9',
      });
      expect(licensePolicy.metadataOnlyPackageAllowlist).toEqual(
        expect.arrayContaining(['@ai-sdk/provider-utils@5.0.18', 'partyserver@0.5.9']),
      );
      expect(config).toMatchObject({
        main: 'src/server.ts',
        ai: { binding: 'AI' },
        durable_objects: { bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] },
        exports: { AppAgent: { type: 'durable-object', storage: 'sqlite' } },
        triggers: { crons: ['0 3 * * *'] },
      });
      expect(config.d1_databases).toHaveLength(2);
      expect(config.d1_databases).toContainEqual(expect.objectContaining({ binding: 'AGENT_SECURITY_DB' }));
      expect(tsconfig.exclude).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('creates an opaque HttpOnly session only for same-origin requests', async () => {
    const db = new MemoryD1();
    const crossOrigin = await handleAgentSessionBootstrap(
      new Request('https://app.example/api/agent/session', {
        method: 'POST',
        headers: { Origin: 'https://attacker.example' },
      }),
      db.database,
      1_000,
    );
    expect(crossOrigin.status).toBe(403);
    expect(db.insertedSession).toBeNull();

    const response = await handleAgentSessionBootstrap(
      new Request('https://app.example/api/agent/session', {
        method: 'POST',
        headers: {
          Origin: 'https://app.example',
          'CF-Connecting-IP': '192.0.2.1',
        },
      }),
      db.database,
      1_000,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Set-Cookie')).toMatch(
      /^__Host-cloudchef_agent_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Strict;/,
    );
    expect(db.insertedSession).toMatchObject({
      expiresAt: 604_801_000,
      createdAt: 1_000,
    });
    expect(db.insertedSession?.agentName).toMatch(/^session-[0-9a-f-]{36}$/);
  });

  test('resolves the private server-side instance name from the session cookie', async () => {
    const db = new MemoryD1();
    db.sessionLookup = { agentName: 'session-private', expiresAt: 9_000 };
    await expect(
      resolveAgentSession(
        new Request('https://app.example/agent', {
          headers: {
            Cookie: `other=value; __Host-cloudchef_agent_session=${'a'.repeat(43)}`,
          },
        }),
        db.database,
        5_000,
      ),
    ).resolves.toEqual({ agentName: 'session-private', expiresAt: 9_000 });
    expect(db.lastSessionLookup?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.lastSessionLookup?.now).toBe(5_000);
  });

  test('rejects malformed session tokens before querying D1', async () => {
    const db = new MemoryD1();

    await expect(
      resolveAgentSession(
        new Request('https://app.example/agent', {
          headers: { Cookie: '__Host-cloudchef_agent_session=short' },
        }),
        db.database,
      ),
    ).resolves.toBeNull();
    expect(db.lastSessionLookup).toBeNull();
  });

  test('does not charge the global session-creation quota for client-local rejections', async () => {
    const db = new MemoryD1();
    const request = () =>
      new Request('https://app.example/api/agent/session', {
        method: 'POST',
        headers: {
          Origin: 'https://app.example',
          'CF-Connecting-IP': '192.0.2.10',
        },
      });
    for (let index = 0; index < 10; index += 1) {
      await expect(handleAgentSessionBootstrap(request(), db.database, 1_000)).resolves.toMatchObject({
        status: 204,
      });
    }
    await expect(handleAgentSessionBootstrap(request(), db.database, 1_000)).resolves.toMatchObject({ status: 429 });

    expect(db.rates.get('session-create:global:0')).toBe(10);
    const clientBucket = [...db.rates.entries()].find(([key]) => key.startsWith('session-create:client:'));
    expect(clientBucket?.[1]).toBe(11);
  });

  test('bounds global daily session-table growth before inserting a session', async () => {
    const db = new MemoryD1();
    db.rates.set('session-create:global:daily:0', GLOBAL_DAILY_SESSION_CREATION_LIMIT);

    const response = await handleAgentSessionBootstrap(
      new Request('https://app.example/api/agent/session', {
        method: 'POST',
        headers: {
          Origin: 'https://app.example',
          'CF-Connecting-IP': '192.0.2.11',
        },
      }),
      db.database,
      1_000,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('86399');
    expect(db.insertedSession).toBeNull();
  });

  test('enforces both per-session and global inference ceilings atomically', async () => {
    const sessionDb = new MemoryD1();
    for (let index = 0; index < 10; index += 1) {
      await expect(consumeAppAgentInferenceBudget(sessionDb.database, 'session-a', 10_000)).resolves.toEqual({
        allowed: true,
      });
    }
    await expect(consumeAppAgentInferenceBudget(sessionDb.database, 'session-a', 10_000)).resolves.toMatchObject({
      allowed: false,
    });
    expect(sessionDb.rates.get('inference:global:0')).toBe(10);
    expect(sessionDb.rates.get('inference:session:session-a:0')).toBe(11);

    const globalDb = new MemoryD1();
    for (let index = 0; index < 60; index += 1) {
      await expect(consumeAppAgentInferenceBudget(globalDb.database, `session-${index}`, 10_000)).resolves.toEqual({
        allowed: true,
      });
    }
    await expect(
      consumeAppAgentInferenceBudget(globalDb.database, 'session-over-global', 10_000),
    ).resolves.toMatchObject({ allowed: false });
  });

  test('enforces a global daily inference ceiling with a day-bound retry', async () => {
    const db = new MemoryD1();
    for (let index = 0; index < GLOBAL_DAILY_INFERENCE_LIMIT; index += 1) {
      const now = 10_000 + index * 60_000;
      await expect(consumeAppAgentInferenceBudget(db.database, `session-${index}`, now)).resolves.toEqual({
        allowed: true,
      });
    }

    const deniedAt = 10_000 + GLOBAL_DAILY_INFERENCE_LIMIT * 60_000;
    await expect(consumeAppAgentInferenceBudget(db.database, 'session-over-daily-limit', deniedAt)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: Math.ceil((24 * 60 * 60 * 1000 - deniedAt) / 1000),
    });
  });

  test('cleans expired session mappings and old rate-limit buckets', async () => {
    const db = new MemoryD1();

    await cleanupExpiredAgentSecurityState(db.database, 200_000_000);

    expect(db.sessionCleanupCutoff).toBe(200_000_000);
    expect(db.rateLimitCleanupCutoff).toBe(113_600_000);
    expect(db.sessionCleanupLimit).toBe(5_000);
    expect(db.rateLimitCleanupLimit).toBe(10_000);
    expect(db.sessionCleanupQuery).toContain('ORDER BY expires_at');
    expect(db.rateLimitCleanupQuery).toContain('ORDER BY window_start');
  });
});

class MemoryD1 {
  readonly rates = new Map<string, number>();
  insertedSession: {
    tokenHash: string;
    agentName: string;
    expiresAt: number;
    createdAt: number;
  } | null = null;
  sessionLookup: { agentName: string; expiresAt: number } | null = null;
  lastSessionLookup: { tokenHash: string; now: number } | null = null;
  sessionCleanupCutoff: number | null = null;
  rateLimitCleanupCutoff: number | null = null;
  sessionCleanupLimit: number | null = null;
  rateLimitCleanupLimit: number | null = null;
  sessionCleanupQuery: string | null = null;
  rateLimitCleanupQuery: string | null = null;

  readonly database = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => {
          if (query.includes('INSERT INTO app_agent_rate_limits')) {
            const key = `${String(values[0])}:${String(values[1])}`;
            const count = (this.rates.get(key) ?? 0) + 1;
            this.rates.set(key, count);
            return { count };
          }
          if (query.includes('SELECT agent_name, expires_at FROM app_agent_sessions')) {
            this.lastSessionLookup = {
              tokenHash: String(values[0]),
              now: Number(values[1]),
            };
            return this.sessionLookup
              ? {
                  agent_name: this.sessionLookup.agentName,
                  expires_at: this.sessionLookup.expiresAt,
                }
              : null;
          }
          throw new Error(`Unexpected first query: ${query}`);
        },
        run: async () => {
          if (query.includes('INSERT INTO app_agent_sessions')) {
            this.insertedSession = {
              tokenHash: String(values[0]),
              agentName: String(values[1]),
              expiresAt: Number(values[2]),
              createdAt: Number(values[3]),
            };
          } else if (query.includes('DELETE FROM app_agent_sessions')) {
            this.sessionCleanupCutoff = Number(values[0]);
            this.sessionCleanupLimit = Number(values[1]);
            this.sessionCleanupQuery = query;
          } else if (query.includes('DELETE FROM app_agent_rate_limits')) {
            this.rateLimitCleanupCutoff = Number(values[0]);
            this.rateLimitCleanupLimit = Number(values[1]);
            this.rateLimitCleanupQuery = query;
          } else {
            throw new Error(`Unexpected run query: ${query}`);
          }
          return { success: true };
        },
      }),
    }),
  } as unknown as D1Database;
}
