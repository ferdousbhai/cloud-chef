import { describe, expect, it } from 'vitest';
import {
  assertReadOnlyCf,
  cfReader,
  collectSession,
  conversationFromGateway,
  memberBranch,
  parseTarget,
  readWorkspaceEvents,
  renderSession,
  summarizeWorkspaceEvents,
  toolFailure,
  workspaceDatabaseName,
} from './ops-session.mjs';

const CONTROL_PLANE = '04680db0-07a0-468d-9547-e07f5091756c';
const WORKSPACE_DB = 'b5ff675f-65c6-49c2-b3dc-4c3cbe972381';
const ACCOUNT = '0af9e0921b880657d84a6c07307f8aef';
const USER = 'b86c65eb-805d-41b3-bbfd-53b50633826d';
const CHAT = '883abe85-6830-4455-9044-2ca6b00cb519';
const INITIAL = 'a53ac334-84a1-476e-b918-9fedf18b4141';
const WORKER = 'cloudchef-workspace-c2dec2a4e30e0871';
const AT = Date.parse('2026-10-20T13:00:00Z');

type CfCall = { args: readonly string[]; accountId?: string };
/** A JSON value, as cf and D1 return them. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function d1Rows(rows: Record<string, Json>[]) {
  return [{ results: rows, success: true }];
}

function sqlOf(args: readonly string[]): { sql: string; params: string[] } {
  return args[1] === 'query' ? JSON.parse(args[args.indexOf('--body') + 1] ?? '{}') : { sql: '', params: [] };
}

function event(id: string, timestamp: number, source: Record<string, Json>, workers: Record<string, Json> = {}) {
  return {
    timestamp,
    source,
    $workers: { scriptName: WORKER, entrypoint: 'BuilderAgent', ...workers },
    $metadata: { id, type: source.event ? 'cf-worker' : 'cf-worker-event', level: source.level ?? 'info' },
  };
}

/** A production that answers each read this script makes, recording every call. */
function fakeProduction() {
  const calls: CfCall[] = [];
  const cf = async (args: readonly string[], options: { accountId?: string } = {}) => {
    assertReadOnlyCf(args);
    calls.push({ args, accountId: options.accountId });
    const command = args.slice(0, 3).join(' ');
    if (args[0] === 'd1' && args[1] === 'list') {
      return [
        { uuid: WORKSPACE_DB, name: 'cloudchef-data-c2dec2a4e30e0871' },
        { uuid: CONTROL_PLANE, name: 'cloudchef' },
      ];
    }
    if (args[0] === 'd1' && args[1] === 'query') {
      const { sql } = sqlOf(args);
      if (sql.includes('FROM "user"')) {
        return d1Rows([{ id: USER, email: 'sara@example.com', ai_gateway_content_logging: 1 }]);
      }
      if (sql.includes('FROM user_computer_runtimes')) {
        return d1Rows([
          {
            user_id: USER,
            worker_name: WORKER,
            account_id: ACCOUNT,
            runtime_version: 'f'.repeat(64),
            protocol_version: 1,
            last_session_at: AT,
            org_name: "Sara's sites",
          },
        ]);
      }
      if (sql.includes('FROM organization_usage_daily')) {
        return d1Rows([{ day: '2026-10-20', turns: 21, input_tokens: 9, output_tokens: 8, cached_tokens: 7 }]);
      }
      if (sql.includes('FROM chats')) {
        return d1Rows([
          {
            id: CHAT,
            initial_id: INITIAL,
            description: 'Retreat Page Signup Button',
            timestamp: '2026-10-20T11:21:06.331Z',
            org_project_id: 'project-1',
            last_activity_at: AT,
          },
        ]);
      }
      if (sql.includes('FROM chat_transcripts')) {
        return d1Rows([{ subchat_index: 0, agent_name: INITIAL, created_at: AT - 3_600_000, updated_at: AT }]);
      }
      if (sql.includes('FROM deployments')) {
        return d1Rows([]);
      }
      if (sql.includes('FROM org_projects')) {
        return d1Rows([{ id: 'project-1', repo_full_name: 'acme/site', default_branch: 'main' }]);
      }
    }
    if (command === 'ai-gateway logs list') {
      return [
        {
          id: 'log-1',
          created_at: '2026-10-20T12:59:00.000Z',
          model: '@cf/model',
          success: true,
          tokens_in: 100,
          tokens_out: 10,
          duration: 2_000,
          metadata: { chat: INITIAL, user: USER, agent: INITIAL },
        },
        // Matched another key's value: not this chat's request.
        { id: 'log-other', created_at: '2026-10-20T12:59:30.000Z', metadata: { chat: 'other', user: INITIAL } },
      ];
    }
    if (command === 'ai-gateway logs get-request') {
      return {
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'Add a signup button' },
          {
            role: 'assistant',
            content: 'Looking at the page first.',
            tool_calls: [{ id: 'call-1', function: { name: 'grep', arguments: '{"path":"src/x.ts"}' } }],
          },
          { role: 'tool', tool_call_id: 'call-1', content: '{"error":"not a directory: src/x.ts"}' },
        ],
        tools: [{}, {}],
      };
    }
    if (command === 'ai-gateway logs get-response') {
      return {
        choices: [
          { delta: { content: 'Done', role: 'assistant' } },
          { delta: { content: ' now.' } },
          { delta: {}, finish_reason: 'stop' },
        ],
      };
    }
    if (command === 'o11y telemetry query') {
      return {
        run: { status: 'COMPLETED' },
        events: {
          events: [
            event('3', AT - 1_000, {
              event: 'workers_ai_finished',
              finishReason: 'stop',
              usage: { inputTokens: 100, outputTokens: 10 },
              durationMs: 2_000,
            }),
            event('2', AT - 2_000, { level: 'warn', message: 'Recovering interrupted CloudChef chat turn' }),
            event('1', AT - 3_000, { event: 'builder_chat_turn_started', continuation: false, firstUserMessage: true }),
          ],
        },
      };
    }
    throw new Error(`unexpected cf ${args.join(' ')}`);
  };
  const ghPaths: string[] = [];
  const gh = async (path: string) => {
    ghPaths.push(path);
    // The member's legacy branch and a conversation's own branch, pushed later.
    if (path.includes('/git/matching-refs/')) {
      return [
        { ref: 'refs/heads/cloudchef/sara-b86c65', object: { sha: 'old' } },
        { ref: 'refs/heads/cloudchef/sara-b86c65-k3y4chat0001', object: { sha: 'new' } },
      ];
    }
    if (path.endsWith('/commits/old') || path.endsWith('/commits/new')) {
      return {
        commit: { committer: { date: path.endsWith('new') ? '2026-10-20T13:40:15Z' : '2026-10-01T00:00:00Z' } },
      };
    }
    if (path.includes('/check-runs')) {
      return {
        check_runs: [
          { name: 'Workers Builds: site', status: 'completed', conclusion: 'success', output: { title: 'Deployed' } },
        ],
      };
    }
    return [
      {
        sha: 'da130d3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        commit: { message: 'Bold the intro\n\nbody', committer: { date: '2026-10-20T13:40:15Z' } },
      },
    ];
  };
  return { cf, calls, gh, ghPaths };
}

describe('ops:session reads production without changing it', () => {
  it('allows only read-only cf commands, single SELECTs, and dry-run log queries', () => {
    expect(() => assertReadOnlyCf(['d1', 'list'])).not.toThrow();
    expect(() =>
      assertReadOnlyCf(['d1', 'query', 'db', '--body', JSON.stringify({ sql: 'SELECT 1', params: [] })]),
    ).not.toThrow();
    for (const args of [
      ['d1', 'execute', 'db'],
      ['d1', 'query', 'db', '--body', JSON.stringify({ sql: 'UPDATE chats SET is_deleted = 1' })],
      ['d1', 'query', 'db', '--body', JSON.stringify({ sql: 'SELECT 1; DROP TABLE chats' })],
      ['d1', 'query', 'db', '--sql', 'SELECT 1'],
      ['ai-gateway', 'logs', 'delete', '--gateway-id', 'default'],
      ['o11y', 'telemetry', 'query', '--body', JSON.stringify({ dry: false })],
      ['deploy'],
    ]) {
      expect(() => assertReadOnlyCf(args), args.join(' ')).toThrow();
    }
  });

  it('runs cf with telemetry off in the runtime account, and refuses a write before starting a process', async () => {
    const runs: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    const run = async (_file: string, args: string[], options: { env: Record<string, string | undefined> }) => {
      runs.push({ args, env: options.env });
      return { stdout: '\n[{"uuid":"db","name":"cloudchef"}]' };
    };
    // SAFETY: the fake implements the one exec signature cfReader calls; no child process starts.
    const cf = cfReader({ run: run as never, env: {} });

    await expect(cf(['d1', 'list'], { accountId: ACCOUNT })).resolves.toEqual([{ uuid: 'db', name: 'cloudchef' }]);
    await expect(cf(['d1', 'execute', 'db'])).rejects.toThrow('read-only');
    expect(runs).toEqual([
      { args: ['exec', 'cf', 'd1', 'list'], env: { CF_SEND_TELEMETRY: 'false', CLOUDFLARE_ACCOUNT_ID: ACCOUNT } },
    ]);
  });

  it('accepts only identifier-shaped targets', () => {
    expect(parseTarget(' sara@example.com ')).toEqual({ value: 'sara@example.com', kind: 'email' });
    expect(parseTarget(CHAT)).toEqual({ value: CHAT, kind: 'id' });
    expect(() => parseTarget("x' OR 1=1 --")).toThrow();
  });
});

describe('ops:session reconstruction', () => {
  it("puts a member's chat together from D1, Workers Logs, AI Gateway, and GitHub", async () => {
    const production = fakeProduction();

    const session = await collectSession(parseTarget('sara@example.com'), {
      cf: production.cf,
      gh: production.gh,
      controlPlaneDatabaseId: CONTROL_PLANE,
      now: AT + 86_400_000,
    });

    expect(session).toMatchObject({
      found: true,
      user: { id: USER },
      chat: { id: CHAT, workerName: WORKER, accountId: ACCOUNT, orgName: "Sara's sites" },
      gateway: { requests: [{ id: 'log-1', tokensIn: 100 }] },
      github: { branch: 'cloudchef/sara-b86c65-k3y4chat0001', project: { repo_full_name: 'acme/site' } },
      unknown: [],
    });
    // Only its own request: the other matched the chat id under another key.
    expect(session.gateway?.requests).toHaveLength(1);
    expect(session.events).toMatchObject({
      turns: [{ firstUserMessage: true }],
      finishes: [{ finishReason: 'stop', inputTokens: 100 }],
      problems: [{ level: 'warn', detail: 'Recovering interrupted CloudChef chat turn' }],
    });
    // The workspace's data and logs are read in the runtime's own account, by the chat's initial id.
    const workspaceCalls = production.calls.filter((call) => call.args[2] === WORKSPACE_DB);
    expect(workspaceCalls.length).toBeGreaterThan(0);
    expect(workspaceCalls.every((call) => call.accountId === ACCOUNT)).toBe(true);
    const gatewayList = production.calls.find((call) => call.args.slice(0, 3).join(' ') === 'ai-gateway logs list');
    expect(gatewayList?.args).toContain(JSON.stringify([{ key: 'metadata.value', operator: 'eq', value: [INITIAL] }]));
    // The log window is anchored on the conversation's requests and activity.
    const telemetry = production.calls.find((call) => call.args[0] === 'o11y');
    const body = JSON.parse(telemetry?.args[4] ?? '{}');
    expect(body).toMatchObject({ dry: true, view: 'events' });
    expect(body.timeframe.from).toBeLessThan(Date.parse('2026-10-20T12:59:00.000Z'));
    expect(body.timeframe.to).toBeGreaterThan(AT);
    expect(production.ghPaths).toEqual([
      'repos/acme/site/git/matching-refs/heads/cloudchef/sara-b86c65',
      'repos/acme/site/commits/old',
      'repos/acme/site/commits/new',
      'repos/acme/site/commits?sha=cloudchef%2Fsara-b86c65-k3y4chat0001&per_page=5',
      'repos/acme/site/commits/da130d3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs?per_page=20',
    ]);

    const text = renderSession(session);
    expect(text).toContain(`Chat ${CHAT} "Retreat Page Signup Button" in ${WORKER} (organization Sara's sites)`);
    expect(text).toContain('[user] Add a signup button');
    expect(text).toContain('[tool call] grep({"path":"src/x.ts"})');
    expect(text).toContain('[tool error] grep: not a directory: src/x.ts');
    expect(text).toContain('[assistant] Done now.');
    expect(text).toContain('WARN log [BuilderAgent] Recovering interrupted CloudChef chat turn');
    expect(text).toContain('da130d3 2026-10-20T13:40:15Z Bold the intro');
    expect(text).toContain('Workers Builds: site: success Deployed');
    expect(text).not.toContain('system prompt');
  });

  it('finds a chat by id across workspaces, and says which sources it could not read', async () => {
    const production = fakeProduction();
    const cf = async (args: readonly string[], options?: { accountId?: string }) => {
      const { sql } = sqlOf(args);
      if (sql.startsWith('SELECT id, email') && sql.includes('lower(email)')) {
        return d1Rows([]);
      }
      if (args[0] === 'o11y') {
        throw new Error('Authentication error [code: 10000]');
      }
      return production.cf(args, options);
    };

    const session = await collectSession(parseTarget(CHAT), { cf, controlPlaneDatabaseId: CONTROL_PLANE, now: AT });

    expect(session).toMatchObject({ found: true, chat: { id: CHAT }, user: { id: USER } });
    const chatQuery = production.calls.find((call) => sqlOf(call.args).sql.includes('FROM chats'));
    expect(sqlOf(chatQuery?.args ?? []).params).toEqual([CHAT]);
    expect(session.events).toBeNull();
    expect(session.unknown).toEqual([
      { source: `Workers Logs for ${WORKER}`, reason: 'Authentication error [code: 10000]' },
    ]);
    expect(renderSession(session)).toContain(`Unknown: Workers Logs for ${WORKER}: Authentication error`);
    // Without a gh login there is no GitHub read, only the project and branch.
    expect(session.github).toMatchObject({ commits: null, branch: 'cloudchef/sara-b86c65' });
  });

  it("reads the latest of only this member's branches, all of them by last commit, and lists the rest", async () => {
    const production = fakeProduction();
    const member = 'cloudchef/sara-b86c65';
    // Alphabetical, as GitHub lists them: 25 older branches before the newest, and branches of others
    // whose names merely start with this member's.
    const refs = [
      ...Array.from({ length: 25 }, (_, index) => ({
        ref: `refs/heads/${member}-a${String(index).padStart(7, '0')}`,
        object: { sha: `old${index}` },
      })),
      { ref: `refs/heads/${member}-zz0newest`, object: { sha: 'newest' } },
      { ref: `refs/heads/${member}x-k3y4chat0001`, object: { sha: 'impostor' } },
      { ref: `refs/heads/${member}-k3y4chat0001-extra`, object: { sha: 'impostor' } },
    ];
    const gh = async (path: string) => {
      if (path.includes('/git/matching-refs/')) {
        return refs;
      }
      const sha = /\/commits\/([a-z0-9]+)$/.exec(path)?.[1];
      if (sha !== undefined) {
        const day = sha === 'newest' || sha === 'impostor' ? 30 : (Number(sha.slice(3)) % 28) + 1;
        return { commit: { committer: { date: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z` } } };
      }
      return production.gh(path);
    };

    const session = await collectSession(parseTarget('sara@example.com'), {
      cf: production.cf,
      gh,
      controlPlaneDatabaseId: CONTROL_PLANE,
      now: AT + 86_400_000,
    });

    expect(session.github?.branch).toBe(`${member}-zz0newest`);
    expect(session.github?.branches?.total).toBe(26);
    expect(session.github?.branches?.latest).toHaveLength(20);
    const dates = session.github?.branches?.latest.map(({ lastCommitAt }) => lastCommitAt) ?? [];
    expect(dates).toEqual(dates.toSorted().reverse());
    const text = renderSession(session);
    expect(text).toContain(`branch ${member}-zz0newest (latest of 26 by last commit; the chat's own isn't recorded)`);
    expect(text).toContain('  and 6 older');
    expect(text).not.toContain(`${member}x-`);
  });

  it('reports a person it cannot find', async () => {
    const cf = async () => d1Rows([]);
    const session = await collectSession(parseTarget('nobody@example.com'), {
      cf,
      controlPlaneDatabaseId: CONTROL_PLANE,
    });
    expect(session.found).toBe(false);
    expect(renderSession(session)).toBe('No session found for nobody@example.com: No CloudChef user has that email.');
  });
});

describe('ops:session pieces', () => {
  it('pages Workers Logs back through the window, dropping the events a page boundary repeats', async () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => event(`a${index}`, 1_000 - index, {})),
      [event('a99', 901, {}), event('b1', 800, {})],
    ];
    const bodies: Array<{ timeframe: { to: number } }> = [];
    const cf = async (args: readonly string[]) => {
      bodies.push(JSON.parse(args[4] ?? '{}'));
      return { run: { status: 'COMPLETED' }, events: { events: pages[bodies.length - 1] ?? [] } };
    };

    const { events, complete } = await readWorkspaceEvents(cf, { workerName: WORKER, from: 0, to: 2_000 });

    expect(complete).toBe(true);
    expect(events).toHaveLength(101);
    expect(bodies.map((body) => body.timeframe.to)).toEqual([2_000, 902]);
  });

  it('counts invocations that did not finish ok as problems', () => {
    const summary = summarizeWorkspaceEvents([
      event('1', 1, { message: 'GET /' }, { eventType: 'fetch', outcome: 'exception', entrypoint: 'ProjectWorkspace' }),
      event('2', 2, { message: 'GET /' }, { eventType: 'fetch', outcome: 'ok' }),
    ]);
    expect(summary.counts).toEqual({ 'fetch invocation': 2 });
    expect(summary.problems).toEqual([
      { at: 1, level: 'info', what: 'fetch exception', detail: 'GET /', entrypoint: 'ProjectWorkspace' },
    ]);
  });

  it('recognizes the tool results the model saw as failures', () => {
    expect(toolFailure('{"error":"boom"}')).toBe('boom');
    expect(toolFailure('{"validation":{"ok":false,"summary":"tsc failed"}}')).toBe('tsc failed');
    expect(toolFailure('{"path":"a","content":"error handling"}')).toBeNull();
    expect(toolFailure('plain output')).toBeNull();
    expect(conversationFromGateway({ messages: [] }, null).entries).toEqual([]);
  });

  it('names the workspace database and member branch as the product does', () => {
    expect(workspaceDatabaseName(WORKER)).toBe('cloudchef-data-c2dec2a4e30e0871');
    expect(memberBranch('Sara.Adolf+x@example.com', 'B86C65EB-805d')).toBe('cloudchef/sara-adolf-x-b86c65');
    expect(memberBranch(undefined, '!!!abc')).toBe('cloudchef/member-000abc');
  });
});
