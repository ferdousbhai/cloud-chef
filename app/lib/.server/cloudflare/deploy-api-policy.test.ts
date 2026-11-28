import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deployApiDecision, deployBindingsCheck, workerSettingsSchema } from './deploy-api-policy';
import recordedRequests from './deploy-api-recorded-requests.json';

/**
 * The requests real publishes sent, recorded through a proxy in front of Cloudflare's API on 2026-11-28 with
 * Wrangler 4.151.3 and cf 1.0.0-rc.6, each publishing a throwaway Worker with static assets, a D1 database, a cron
 * trigger and (one of cf's) a Durable Object; the account, the Worker and the database are renamed. Replayed here, so
 * what the builder's proxy lets through for `cf` is shown to be no more than it let through for Wrangler.
 */
const recorded = z
  .array(
    z.object({
      client: z.enum(['cf', 'wrangler']),
      what: z.string(),
      requests: z.array(z.object({ method: z.string(), path: z.string(), settings: z.unknown().optional() })),
    }),
  )
  .parse(recordedRequests);
const ACCOUNT = 'acc';
const WORKER = 'glossary';
const DATABASE = '11111111-1111-4111-8111-111111111111';
const decide = (request: { method: string; path: string }, workerName = WORKER) =>
  deployApiDecision({ method: request.method, pathname: request.path }, { accountId: ACCOUNT, workerName });

const requests = (client: string) => recorded.filter((set) => set.client === client).flatMap((set) => set.requests);
const key = (request: { method: string; path: string }) => `${request.method} ${request.path}`;
const OWN_WORKER = new RegExp(`^/client/v4/accounts/${ACCOUNT}/workers/(scripts|services|workers)/${WORKER}(/|$)`);

describe('the requests a recorded publish sends, replayed against what a deploy may ask', () => {
  it('has every kind of publish from both tools', () => {
    expect(recorded.map((set) => `${set.client}: ${set.what}`)).toEqual([
      'cf: first production deploy',
      'cf: production deploy of a Worker already there',
      'cf: production deploy of a Worker with a Durable Object',
      'cf: preview version with an alias',
      'cf: D1 migrations by database id',
      'wrangler: first production deploy',
      'wrangler: production deploy of a Worker already there',
      'wrangler: preview version with an alias',
      'wrangler: D1 migrations by database name',
    ]);
  });

  it.each(['cf', 'wrangler'])('lets every request of %s through', (client) => {
    for (const request of requests(client)) {
      expect(`${key(request)}: ${decide(request)}`).not.toBe(`${key(request)}: refused`);
    }
  });

  it('lets cf ask nothing outside its own Worker that Wrangler did not ask', () => {
    const wrangler = new Set(requests('wrangler').map(key));
    const beyond = requests('cf').filter((request) => !OWN_WORKER.test(request.path));
    expect(beyond.length).toBeGreaterThan(0);
    for (const request of beyond) {
      expect(wrangler.has(key(request)) ? 'asked by Wrangler too' : key(request)).toBe('asked by Wrangler too');
    }
    // And those are the workers.dev subdomain, the asset upload and SQL on the one database.
    expect([...new Set(beyond.map(key))].sort()).toEqual([
      `GET /client/v4/accounts/${ACCOUNT}/workers/subdomain`,
      `POST /client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,
      `POST /client/v4/accounts/${ACCOUNT}/workers/assets/upload`,
    ]);
  });

  it('refuses every request cf sends for its Worker when the deploy is of another Worker', () => {
    const own = requests('cf').filter((request) => OWN_WORKER.test(request.path));
    expect(own.length).toBeGreaterThan(20);
    for (const request of own) {
      expect(`${key(request)}: ${decide(request, 'other-site')}`).toBe(`${key(request)}: refused`);
    }
  });

  it('checks the settings of every write cf makes to its Worker, and sends its SQL only once the database is', () => {
    for (const request of requests('cf').filter((sent) => sent.method !== 'GET')) {
      const expected = request.path.endsWith('/workers/assets/upload')
        ? 'as_sent'
        : request.path.endsWith('/schedules')
          ? 'with_token'
          : request.path.includes('/d1/database/')
            ? 'check_database'
            : 'check_bindings';
      expect(`${key(request)}: ${decide(request)}`).toBe(`${key(request)}: ${expected}`);
    }
  });

  it('reads the settings cf uploads, and finds nothing in them that reaches beyond the Worker', () => {
    const uploads = requests('cf').flatMap((request) =>
      decide(request) === 'check_bindings' && request.settings !== undefined ? [request.settings] : [],
    );
    expect(uploads.length).toBeGreaterThan(8);
    const databases = new Set<string>();
    for (const settings of uploads) {
      const checked = deployBindingsCheck(workerSettingsSchema.parse(settings), WORKER);
      expect(checked).not.toHaveProperty('refusal');
      if ('lookups' in checked) {
        checked.lookups.databases.forEach((id) => databases.add(id));
      }
    }
    expect([...databases]).toEqual([DATABASE]);
  });

  it('still refuses what it refused before cf: other Workers, domains, routes, stored data, tokens, deletions', () => {
    const refused: [string, string][] = [
      ['PUT', '/accounts/acc/workers/scripts/cloudchef'],
      ['PUT', '/accounts/acc/workers/scripts/other-site'],
      ['POST', '/accounts/acc/workers/scripts/other-site/versions'],
      ['POST', '/accounts/acc/workers/scripts/other-site/deployments'],
      ['PATCH', '/accounts/acc/workers/scripts/other-site/script-settings'],
      ['DELETE', '/accounts/acc/workers/scripts/glossary'],
      ['GET', '/accounts/acc/workers/scripts'],
      ['GET', '/accounts/acc/workers/workers/other-site'],
      ['GET', '/accounts/acc/workers/scripts/other-site/settings'],
      ['GET', '/accounts/acc/workers/scripts/other-site/secrets'],
      ['PUT', '/accounts/acc/workers/domains'],
      ['PUT', '/accounts/acc/workers/domains/records'],
      ['PUT', '/accounts/acc/workers/scripts/glossary/domains/records'],
      ['PUT', '/accounts/acc/workers/scripts/glossary/routes'],
      ['POST', '/zones/zone/workers/routes'],
      ['GET', '/accounts'],
      ['GET', '/accounts/other/workers/scripts'],
      ['GET', '/user/tokens'],
      ['POST', '/user/tokens'],
      ['GET', '/accounts/acc/r2/buckets/glossary-files/objects/secret'],
      ['GET', '/accounts/acc/storage/kv/namespaces/ns/values/secret'],
      ['GET', '/accounts/acc/secrets_store/stores'],
      ['POST', '/accounts/acc/d1/database/not-an-id/query'],
      ['DELETE', `/accounts/acc/d1/database/${DATABASE}`],
      ['POST', '/accounts/acc/queues'],
      ['PUT', '/accounts/acc/workflows/cloudchef-project-deletion'],
      ['PUT', '/accounts/acc/workers/scripts/glossary/..%2fcloudchef'],
      ['PUT', '/accounts/acc/workers/scripts/glossary/../cloudchef'],
    ];
    for (const [method, path] of refused) {
      expect(`${method} ${path}: ${decide({ method, path: `/client/v4${path}` })}`).toBe(`${method} ${path}: refused`);
    }
  });
});

describe('what a Worker declares of its own classes', () => {
  const check = (settings: Parameters<typeof deployBindingsCheck>[0]) => deployBindingsCheck(settings, WORKER);

  it('may be its own Durable Objects and Workflows, as cf declares them', () => {
    expect(
      check({
        exports: {
          AppAgent: { type: 'durable-object', storage: 'sqlite' },
          Orders: { type: 'workflow', name: 'glossary-orders' },
          Moved: { type: 'durable-object', state: 'expecting-transfer', storage: 'sqlite', transferFrom: WORKER },
        },
      }),
    ).toEqual({ lookups: { databases: [], namespaces: [] } });
  });

  it('is never a Workflow of CloudChef’s, nor a Durable Object taken from another Worker', () => {
    expect(check({ exports: { X: { type: 'workflow', name: 'cloudchef-project-deletion' } } })).toHaveProperty(
      'refusal',
    );
    for (const field of ['transferFrom', 'transfer_from']) {
      expect(
        check({
          exports: {
            X: { type: 'durable-object', state: 'expecting-transfer', storage: 'sqlite', [field]: 'cloudchef' },
          },
        }),
      ).toHaveProperty('refusal');
    }
  });
});
