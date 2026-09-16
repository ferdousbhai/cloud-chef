import { describe, expect, it, vi } from 'vitest';
import {
  collectReport,
  describeBuilderModel,
  readPinnedBuilderModel,
  coreStatements,
  parseD1Response,
  readWorkerInvocations,
  renderReport,
  WORKER_INVOCATIONS_QUERY,
} from './ops-report.mjs';

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const DAY = 86_400_000;
const CURRENT_RUNTIME = 'a'.repeat(64);
const OLD_RUNTIME = 'b'.repeat(64);

describe('read-only production access', () => {
  it('issues only SELECT statements against the control-plane database', () => {
    for (const statement of coreStatements(NOW)) {
      expect(statement.trim()).toMatch(/^SELECT\b/i);
      expect(statement).not.toMatch(/\b(?:DELETE|INSERT|REPLACE|UPDATE|DROP|ALTER|CREATE)\b/i);
    }
  });

  it('reads the named Worker through the exact authenticated analytics query', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Response.json({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  {
                    dimensions: { status: 'success' },
                    sum: { requests: 1, errors: 0 },
                    avg: { sampleInterval: 1 },
                  },
                ],
              },
            ],
          },
        },
      });
    });
    const run = async (_file: string, args: string[]) => {
      if (args.includes('whoami')) {
        return { stdout: JSON.stringify({ accounts: [{ id: 'account-1', name: 'One' }] }) };
      }
      return { stdout: JSON.stringify({ type: 'oauth', token: 'oauth-token' }) };
    };

    // SAFETY: the fake implements the two exec invocations this reader makes; no child process is started.
    await readWorkerInvocations({ now: NOW, run: run as never, fetchImpl, env: {} });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(new Headers(call?.init.headers).get('authorization')).toBe('Bearer oauth-token');
    const body = JSON.parse(String(call?.init.body));
    expect(body).toEqual({
      query: WORKER_INVOCATIONS_QUERY,
      variables: {
        account: 'account-1',
        script: 'ghostbuild',
        from: new Date(NOW - DAY).toISOString(),
        to: new Date(NOW).toISOString(),
      },
    });
  });

  it('never includes credential command output in an operator error', async () => {
    const run = async (_file: string, args: string[]) => {
      if (args.includes('whoami')) {
        return { stdout: JSON.stringify({ accounts: [{ id: 'account-1' }] }) };
      }
      throw Object.assign(new Error('Command failed'), {
        stdout: 'super-secret-token',
        stderr: 'Not logged in. Please run `wrangler login`.',
      });
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('fetch must not run');
    });

    // SAFETY: the fake implements the two exec invocations this reader makes; no child process is started.
    const read = readWorkerInvocations({
      now: NOW,
      run: run as never,
      fetchImpl,
      env: {},
    });

    await expect(read).rejects.toThrow('Not logged in. Please run `wrangler login`.');
    await expect(read).rejects.not.toThrow(/super-secret-token/);
  });
});

describe('production report', () => {
  it('does not turn malformed Wrangler output into an empty healthy result', () => {
    expect(() => parseD1Response('not json at all')).toThrow('did not return a D1 result array');
  });

  it('reports every healthy subsystem structurally', async () => {
    const report = await collectReport({
      query: fixtureQuery(healthyRows()),
      readInvocations: healthyInvocations,
      readModelCatalog: healthyCatalog,
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
      pinnedBuilderModel: PIN,
    });

    expect(report).toMatchObject({
      controlPlaneReadable: true,
      status: 'ok',
      headline: 'Everything is healthy: all 6 checks passed.',
    });
    expect(report.checks.map((item: { id: string }) => item.id)).toEqual([
      'control-plane-worker',
      'builder-model',
      'cloudflare-accounts',
      'workspace-runtimes',
      'users',
      'sessions',
    ]);
  });

  it('surfaces broken connections and stale runtimes ahead of healthy checks', async () => {
    const rows = healthyRows();
    rows[1] = [
      { status: 'active', count: 1, missing_credential: 0 },
      { status: 'error', count: 1, missing_credential: 0 },
    ];
    rows[3]![0]!.runtime_version = OLD_RUNTIME;

    const report = await collectReport({
      query: fixtureQuery(rows),
      readInvocations: healthyInvocations,
      readModelCatalog: healthyCatalog,
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
      pinnedBuilderModel: PIN,
    });
    const rendered = renderReport(report);

    expect(report.status).toBe('error');
    expect(report.headline).toBe('1 check is broken, 1 check needs attention.');
    expect(rendered.indexOf('BROKEN')).toBeLessThan(rendered.indexOf('NEEDS ATTENTION'));
    expect(rendered).toContain("runtime bbbbbbbbbbbb, not this checkout's aaaaaaaaaaaa");
  });

  it('marks control-plane checks unknown when Wrangler cannot read D1', async () => {
    const report = await collectReport({
      query: async () => {
        throw new Error('You are not authenticated.');
      },
      readInvocations: healthyInvocations,
      readModelCatalog: healthyCatalog,
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
      pinnedBuilderModel: PIN,
    });

    expect(report).toMatchObject({
      controlPlaneReadable: false,
      status: 'unknown',
      headline: 'The control plane could not be read: You are not authenticated.',
    });
    expect(
      report.checks
        .filter((item: { status: string }) => item.status === 'unknown')
        .map((item: { id: string }) => item.id),
    ).toEqual(expect.arrayContaining(['users', 'cloudflare-accounts', 'sessions', 'workspace-runtimes']));
    expect(renderReport(report)).not.toContain('Everything is healthy');
  });
});

describe('builder model pin', () => {
  it('reads the pin from the module that declares it, not from a copy', async () => {
    const pin = await readPinnedBuilderModel();

    // Whatever the pin currently is, the report must agree with the source of truth.
    expect(pin?.id).toMatch(/^@cf\//);
    expect(pin?.minimumContextTokens).toBeGreaterThan(0);
  });

  it('calls the pin current when nothing newer is published', () => {
    expect(describeBuilderModel([catalogEntry(PIN.id, '2026-05-01')], PIN)).toMatchObject({ level: 'ok' });
  });

  it('names newer builder-capable models without claiming the runtime would pick them', () => {
    const described = describeBuilderModel(
      [catalogEntry(PIN.id, '2026-05-01'), catalogEntry('@cf/example/newer', '2026-09-01')],
      PIN,
    );

    expect(described.level).toBe('attention');
    expect(described.sentence).toContain('@cf/example/newer');
    expect(described.sentence).toContain('narrower test');
  });

  it('treats a pin missing from a readable catalog as broken, not merely stale', () => {
    const described = describeBuilderModel([catalogEntry('@cf/example/other', '2026-09-01')], PIN);

    expect(described).toMatchObject({ level: 'error', detail: { listed: false } });
  });

  it('ignores models the builder could never run', () => {
    const entries = [
      catalogEntry(PIN.id, '2026-05-01'),
      {
        ...catalogEntry('@cf/example/no-tools', '2026-09-01'),
        properties: [{ property_id: 'context_window', value: '131072' }],
      },
      { ...catalogEntry('@cf/example/partner', '2026-09-01'), source: 2 },
      catalogEntry('@cf/example/tiny', '2026-09-01', '16384'),
    ];

    expect(describeBuilderModel(entries, PIN)).toMatchObject({ level: 'ok' });
  });

  it('stays quiet when the pin itself is undated, since there is no "since" to measure', () => {
    const entries = [catalogEntry(PIN.id, undefined), catalogEntry('@cf/example/newer', '2026-09-01')];

    expect(describeBuilderModel(entries, PIN)).toMatchObject({ level: 'ok' });
  });
});

const PIN = { id: '@cf/zai-org/glm-5.3-flash', minimumContextTokens: 32_768 };

function catalogEntry(name: string, createdAt: string | undefined, contextWindow = '1048576') {
  return {
    name,
    source: 1,
    created_at: createdAt,
    task: { name: 'Text Generation' },
    properties: [
      { property_id: 'context_window', value: contextWindow },
      { property_id: 'function_calling', value: 'true' },
    ],
  };
}

async function healthyCatalog() {
  return [catalogEntry(PIN.id, '2026-05-01')];
}

type Row = Record<string, string | number | null>;
type Rows = Row[][];

function healthyRows(): Rows {
  return [
    [{ total: 2, joined_this_week: 1, joined_last_week: 1 }],
    [{ status: 'active', count: 2, missing_credential: 0 }],
    [{ unexpired: 3 }],
    [
      {
        email: 'a@example.com',
        status: 'ready',
        runtime_version: CURRENT_RUNTIME,
        updated_at: NOW - 3_600_000,
      },
      {
        email: 'b@example.com',
        status: 'ready',
        runtime_version: CURRENT_RUNTIME,
        updated_at: NOW - 7_200_000,
      },
    ],
  ];
}

function fixtureQuery(rows: Rows) {
  return async () => rows;
}

async function healthyInvocations() {
  return [
    {
      dimensions: { status: 'success' },
      sum: { requests: 640, errors: 0 },
      avg: { sampleInterval: 1 },
    },
  ];
}
