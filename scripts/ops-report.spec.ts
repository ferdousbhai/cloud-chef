import { describe, expect, it } from 'vitest';
import {
  collectReport,
  describeBuilderModel,
  readPinnedBuilderModel,
  coreStatements,
  parseD1Response,
  queryProduction,
  readWorkerInvocations,
  readWorkersAiCatalog,
  renderReport,
  workerInvocationsQuery,
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

  it('queries the database cloudflare.config.ts binds as DB through cf, without telemetry', async () => {
    const calls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    const run = async (_file: string, args: string[], options: { env: Record<string, string | undefined> }) => {
      calls.push({ args, env: options.env });
      return { stdout: JSON.stringify([{ results: [{ total: 2 }], success: true }]) };
    };

    // SAFETY: the fake implements the one exec invocation this reader makes; no child process is started.
    await expect(queryProduction('SELECT 1 AS total', { run: run as never, env: {} })).resolves.toEqual([
      [{ total: 2 }],
    ]);

    expect(calls).toEqual([
      {
        args: ['exec', 'cf', 'd1', 'query', expect.stringMatching(/^[0-9a-f-]{36}$/), '--sql', 'SELECT 1 AS total'],
        env: { CF_SEND_TELEMETRY: 'false' },
      },
    ]);
    expect(calls[0]?.args[4]).not.toBe('00000000-0000-0000-0000-000000000000');
  });

  it("reads the named Worker's outcomes from Workers Logs with a dry-run query that saves nothing", async () => {
    const calls: string[][] = [];
    const run = async (_file: string, args: string[]) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          run: { status: 'COMPLETED' },
          calculations: [{ aggregates: healthyInvocationRows() }],
        }),
      };
    };

    // SAFETY: the fake implements the one exec invocation this reader makes; no child process is started.
    await expect(readWorkerInvocations({ now: NOW, run: run as never, env: {} })).resolves.toEqual(
      healthyInvocationRows(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 6)).toEqual(['exec', 'cf', 'o11y', 'telemetry', 'query', '--body']);
    const body = JSON.parse(calls[0]?.[6] ?? 'null');
    expect(body).toEqual(workerInvocationsQuery(NOW));
    expect(body).toMatchObject({
      dry: true,
      timeframe: { from: NOW - DAY, to: NOW },
      parameters: {
        filters: expect.arrayContaining([
          { key: '$workers.scriptName', operation: 'eq', type: 'string', value: 'cloudchef' },
        ]),
        groupBys: [{ type: 'string', value: '$workers.outcome' }],
      },
    });
  });

  it('reads the builder-capable Workers AI catalog through cf', async () => {
    const calls: string[][] = [];
    const run = async (_file: string, args: string[]) => {
      calls.push(args);
      return { stdout: JSON.stringify([catalogEntry(PIN.id, '2026-05-01')]) };
    };

    // SAFETY: the fake implements the one exec invocation this reader makes; no child process is started.
    await expect(readWorkersAiCatalog({ run: run as never, env: {} })).resolves.toHaveLength(1);
    expect(calls).toEqual([
      ['exec', 'cf', 'ai', 'models', 'list', '--task', 'Text Generation', '--hide-experimental', '--per-page', '100'],
    ]);
  });

  it("quotes only cf's own reason in an operator error, never what it wrote to stdout", async () => {
    const run = async () => {
      throw Object.assign(new Error('Command failed'), {
        stdout: 'row data that is not an error',
        stderr:
          "\n┌ Error\n│ No authentication token found.\n│\n│ Run 'cf auth login' to authenticate via OAuth\n└\n[ELIFECYCLE] Command failed.",
      });
    };

    // SAFETY: the fake implements the one exec invocation this reader makes; no child process is started.
    const read = readWorkerInvocations({ now: NOW, run: run as never, env: {} });

    await expect(read).rejects.toThrow("No authentication token found. Run 'cf auth login' to authenticate via OAuth");
    await expect(read).rejects.not.toThrow(/row data|ELIFECYCLE/);
  });

  it('treats a log query that did not complete as unreadable rather than as an idle Worker', async () => {
    const run = async () => ({ stdout: JSON.stringify({ run: { status: 'FAILED' }, calculations: [] }) });

    // SAFETY: the fake implements the one exec invocation this reader makes; no child process is started.
    await expect(readWorkerInvocations({ now: NOW, run: run as never, env: {} })).rejects.toThrow('finished as FAILED');
  });
});

describe('production report', () => {
  it('does not turn malformed cf output into an empty healthy result', () => {
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

  it('marks control-plane checks unknown when cf cannot read D1', async () => {
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

describe('control-plane Worker check', () => {
  it('counts every outcome but the benign ones as a fault and points at the exception text', async () => {
    const report = await collectReport({
      query: fixtureQuery(healthyRows()),
      readInvocations: async () => [...healthyInvocationRows(), invocationRow('exception', 12)],
      readModelCatalog: healthyCatalog,
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
      pinnedBuilderModel: PIN,
    });
    const worker = report.checks.find((item: { id: string }) => item.id === 'control-plane-worker');

    expect(worker).toMatchObject({
      status: 'error',
      detail: { invocations: 655, faulted: 12, byStatus: { ok: 640, canceled: 3, exception: 12 }, logsAvailable: true },
    });
    expect(worker?.sentence).toContain('(exception 12)');
    expect(worker?.sentence).toContain('cf o11y telemetry query');
  });

  it('reports a Workers Logs shape it cannot read as drift, not as zero invocations', async () => {
    const report = await collectReport({
      query: fixtureQuery(healthyRows()),
      readInvocations: async () => [{ groups: [], count: 5 }],
      readModelCatalog: healthyCatalog,
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
      pinnedBuilderModel: PIN,
    });

    expect(report.checks.find((item: { id: string }) => item.id === 'control-plane-worker')).toMatchObject({
      status: 'unknown',
      detail: { schemaMismatch: true },
    });
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
    expect(described.sentence).toContain('not a recommendation');
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

function invocationRow(outcome: string, count: number) {
  return { groups: [{ key: '$workers.outcome', value: outcome }], groupKey: outcome, count, sampleInterval: 1 };
}

function healthyInvocationRows() {
  return [invocationRow('ok', 640), invocationRow('canceled', 3)];
}

async function healthyInvocations() {
  return healthyInvocationRows();
}
