import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CloudflareExecutionPublicState } from 'cloudchef-agent/cloudflare-api';
import {
  BuilderCloudflareExecutionRepository,
  cloudflareChangeAnswer,
  ONE_CHANGE_PER_COMMAND,
  type CloudflareExecutionBinding,
} from './builder-cloudflare-execution';

type TestRow = {
  execution_id: string;
  tool_call_id: string;
  user_id: string;
  account_id: string;
  connection_id: string;
  connection_generation: number;
  transcript_agent_name: string;
  transcript_chat_initial_id: string;
  transcript_subchat_index: number;
  transcript_parent_agent_name: string | null;
  execute_input_json: string;
  proposal_sha256: string;
  risk_reasons_json: string;
  status: string;
  created_at: number;
  decided_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  expires_at: number;
  outcome_json: string | null;
};

class TestExecutionStorage {
  readonly rows = new Map<string, TestRow>();

  readonly sql = {
    exec: (query: string, ...bindings: unknown[]): TestSqlResult => {
      const normalized = query.replace(/\s+/gu, ' ').trim();
      if (normalized.startsWith('SELECT') && normalized.includes('WHERE execution_id = ?')) {
        const row = this.rows.get(String(bindings[0]));
        return result(row ? [row] : []);
      }
      if (normalized.startsWith('SELECT') && normalized.includes('WHERE tool_call_id = ?')) {
        const row = [...this.rows.values()].find((candidate) => candidate.tool_call_id === bindings[0]);
        return result(row ? [row] : []);
      }
      if (normalized.startsWith('SELECT') && normalized.includes('ORDER BY created_at DESC')) {
        const limit = Number(bindings[0]);
        const rows = [...this.rows.values()]
          .sort(
            (left, right) => right.created_at - left.created_at || right.execution_id.localeCompare(left.execution_id),
          )
          .slice(0, limit);
        return result(rows);
      }
      if (normalized.startsWith('INSERT INTO builder_cloudflare_executions')) {
        const row: TestRow = {
          execution_id: String(bindings[0]),
          tool_call_id: String(bindings[1]),
          user_id: String(bindings[2]),
          account_id: String(bindings[3]),
          connection_id: String(bindings[4]),
          connection_generation: Number(bindings[5]),
          transcript_agent_name: String(bindings[6]),
          transcript_chat_initial_id: String(bindings[7]),
          transcript_subchat_index: Number(bindings[8]),
          transcript_parent_agent_name: bindings[9] === null ? null : String(bindings[9]),
          execute_input_json: String(bindings[10]),
          proposal_sha256: String(bindings[11]),
          risk_reasons_json: String(bindings[12]),
          status: 'awaiting_approval',
          created_at: Number(bindings[13]),
          decided_at: null,
          started_at: null,
          completed_at: null,
          expires_at: Number(bindings[14]),
          outcome_json: null,
        };
        this.rows.set(row.execution_id, row);
        return result([], 1);
      }
      // Like the Durable Object cursor, an unconsumed UPDATE reports no rows written yet.
      if (normalized.includes("SET status = 'approved'")) {
        const row = this.rows.get(String(bindings[1]));
        if (row) {
          row.status = 'approved';
          row.decided_at = Number(bindings[0]);
        }
        return result([]);
      }
      if (normalized.includes("SET status = 'rejected'")) {
        const row = this.rows.get(String(bindings[3]));
        if (row) {
          row.status = 'rejected';
          row.decided_at = Number(bindings[0]);
          row.completed_at = Number(bindings[1]);
          row.outcome_json = String(bindings[2]);
        }
        return result([]);
      }
      if (normalized.includes("SET status = 'executing'")) {
        const row = this.rows.get(String(bindings[1]));
        if (row) {
          row.status = 'executing';
          row.started_at = Number(bindings[0]);
        }
        return result([]);
      }
      if (normalized.includes('SET status = ?, completed_at = ?')) {
        const row = this.rows.get(String(bindings[3]));
        const written = row?.status === 'executing';
        if (row && written) {
          row.status = String(bindings[0]);
          row.completed_at = Number(bindings[1]);
          row.outcome_json = String(bindings[2]);
        }
        return result([], written ? 1 : 0);
      }
      if (normalized.includes("SET status = 'failed'")) {
        const row = this.rows.get(String(bindings[2]));
        const written = row?.status === 'approved';
        if (row && written) {
          row.status = 'failed';
          row.completed_at = Number(bindings[0]);
          row.outcome_json = String(bindings[1]);
        }
        return result([], written ? 1 : 0);
      }
      if (normalized.includes("SET status = 'indeterminate'")) {
        const row = this.rows.get(String(bindings[2]));
        const written =
          row !== undefined &&
          row.proposal_sha256 === bindings[3] &&
          (row.status === 'awaiting_approval' || row.status === 'approved' || row.status === 'executing');
        if (row && written) {
          row.status = 'indeterminate';
          row.completed_at = Number(bindings[0]);
          row.outcome_json = String(bindings[1]);
        }
        return result([], written ? 1 : 0);
      }
      if (normalized.includes("SET status = 'expired'") && normalized.includes('WHERE execution_id = ?')) {
        const row = this.rows.get(String(bindings[2]));
        const written = row?.status === 'awaiting_approval';
        if (row && written) {
          row.status = 'expired';
          row.completed_at = Number(bindings[0]);
          row.outcome_json = String(bindings[1]);
        }
        return result([], written ? 1 : 0);
      }
      if (normalized.includes("SET status = 'expired'")) {
        let written = 0;
        for (const row of this.rows.values()) {
          if (row.status === 'awaiting_approval' && row.expires_at <= Number(bindings[2])) {
            row.status = 'expired';
            row.completed_at = Number(bindings[0]);
            row.outcome_json = String(bindings[1]);
            written += 1;
          }
        }
        return result([], written);
      }
      throw new Error(`Unhandled test SQL: ${normalized}`);
    },
  };

  transactionSync<T>(callback: () => T): T {
    return callback();
  }
}

const binding: CloudflareExecutionBinding = {
  userId: 'user-1',
  accountId: 'account-1',
  connectionId: 'connection-1',
  connectionGeneration: 4,
  transcript: {
    agentName: 'chat',
    chatInitialId: 'chat',
    subchatIndex: 0,
    parentAgentName: null,
  },
};

function executionRepository(storage = new TestExecutionStorage()) {
  // SAFETY: the repository exercises only synchronous SQL iteration, rowsWritten, and
  // transactionSync; this test double implements those exact members for every emitted query.
  return { storage, repository: new BuilderCloudflareExecutionRepository(storage as never) };
}

describe('durable Cloudflare execution approval repository', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits duplicate approvals but claims execution exactly once', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'tool-1',
      binding,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old' },
    });

    const approvals = await Promise.all([
      repository.approve(proposal.executionId, binding),
      repository.approve(proposal.executionId, binding),
    ]);
    expect(approvals.filter((approval) => approval.transitioned)).toHaveLength(1);

    const claims = await Promise.all([
      repository.beginExecution(proposal.executionId, binding),
      repository.beginExecution(proposal.executionId, binding),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const completed = repository.complete(proposal.executionId, 'succeeded', { status: 'success', summary: 'done' });
    expect(completed.status).toBe('succeeded');
    await expect(repository.beginExecution(proposal.executionId, binding)).resolves.toBeNull();
  });

  it.each([
    ['user', { userId: 'user-2' }],
    ['account', { accountId: 'account-2' }],
    ['connection', { connectionId: 'connection-2' }],
    ['generation', { connectionGeneration: 5 }],
    ['transcript', { transcript: { ...binding.transcript, subchatIndex: 1 } }],
  ])('rejects a %s identity mismatch', async (_label, changed) => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'tool-2',
      binding,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old' },
    });
    await expect(repository.approve(proposal.executionId, { ...binding, ...changed })).rejects.toMatchObject({
      name: 'CloudflareExecutionDecisionError',
    });
  });

  it('rejects a stored proposal digest mismatch', async () => {
    const { repository, storage } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'tool-3',
      binding,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old' },
    });
    const row = storage.rows.get(proposal.executionId);
    if (!row) {
      throw new Error('Test proposal row was not stored.');
    }
    row.proposal_sha256 = 'b'.repeat(64);

    await expect(repository.approve(proposal.executionId, binding)).rejects.toThrow(
      'stored Cloudflare execution digest',
    );
  });

  it('expires awaiting approvals and prevents a late decision', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'tool-4',
      binding,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old' },
    });

    vi.useFakeTimers({ toFake: ['Date'], now: proposal.expiresAt });
    await expect(repository.approve(proposal.executionId, binding)).rejects.toThrow('can no longer be approved');
    expect(repository.get(proposal.executionId)?.status).toBe('expired');
  });

  it('terminalizes recovered approval fibers as indeterminate and never claims them afterward', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'tool-5',
      binding,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old' },
    });
    await repository.approve(proposal.executionId, binding);
    await repository.beginExecution(proposal.executionId, binding);

    const recovered = repository.recoverIndeterminate(proposal.executionId, proposal.proposalSha256);
    expect(recovered.status).toBe('indeterminate');
    expect(recovered.outcome?.status).toBe('indeterminate');
    await expect(repository.beginExecution(proposal.executionId, binding)).resolves.toBeNull();
  });
});

describe('a change a workspace command asked for', () => {
  const deleteSite = {
    method: 'DELETE' as const,
    url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/site',
  };

  it('shows the exact request with its risk, and CloudChef’s note on what it does', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'exec-1',
      binding,
      request: deleteSite,
      warning: 'This deletes the site people visit.',
    });

    expect(proposal).toMatchObject({
      toolCallId: 'exec-1',
      request: deleteSite,
      riskNote: expect.stringMatching(/^This deletes the site people visit\. This changes your Cloudflare account/),
    });
  });

  it('keeps one change per command: the same one again is the same proposal, another is refused', async () => {
    const { repository } = executionRepository();
    const first = await repository.createProposal({ toolCallId: 'exec-1', binding, request: deleteSite });

    await expect(
      repository.createProposal({ toolCallId: 'exec-1', binding, request: deleteSite }),
    ).resolves.toMatchObject({ executionId: first.executionId });
    await expect(
      repository.createProposal({
        toolCallId: 'exec-1',
        binding,
        request: { ...deleteSite, url: deleteSite.url.replace('site', 'other') },
      }),
    ).rejects.toThrow(ONE_CHANGE_PER_COMMAND);
  });

  it('withdraws the change of a command that ended before anyone decided, so it can never be approved', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({ toolCallId: 'exec-1', binding, request: deleteSite });

    expect(repository.withdraw('exec-1')).toBe(true);
    expect(repository.withdraw('exec-1')).toBe(false);
    const withdrawn = repository.get(proposal.executionId)!;
    expect(withdrawn.status).toBe('expired');
    expect(withdrawn.outcome?.summary).toContain('The command ended before anyone approved the change');
    await expect(repository.approve(proposal.executionId, binding)).rejects.toThrow('can no longer be approved');
  });

  it('withdraws nothing once a change was approved', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({ toolCallId: 'exec-1', binding, request: deleteSite });
    await repository.approve(proposal.executionId, binding);

    expect(repository.withdraw('exec-1')).toBe(false);
    expect(repository.get(proposal.executionId)?.status).toBe('approved');
  });
});

describe('what cf is answered about a change', () => {
  const state = (overrides: Partial<CloudflareExecutionPublicState>): CloudflareExecutionPublicState => ({
    executionId: 'execution-1',
    toolCallId: 'exec-1',
    accountId: 'account-1',
    proposalSha256: 'a'.repeat(64),
    status: 'awaiting_approval',
    createdAt: 1,
    decidedAt: null,
    startedAt: null,
    completedAt: null,
    expiresAt: 2,
    outcome: null,
    request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/site' },
    riskNote: 'risk',
    ...overrides,
  });
  const errorSchema = z.object({ errors: z.array(z.object({ message: z.string() })) });
  const message = (answer: ReturnType<typeof cloudflareChangeAnswer>) =>
    answer.kind === 'answer' ? errorSchema.parse(JSON.parse(answer.body)).errors[0]?.message : null;

  it.each(['awaiting_approval', 'approved', 'executing'] as const)('keeps cf waiting while it is %s', (status) => {
    expect(cloudflareChangeAnswer(state({ status }))).toEqual({ kind: 'waiting', executionId: 'execution-1' });
  });

  it("answers with Cloudflare's own answer once the change was made", () => {
    expect(
      cloudflareChangeAnswer(
        state({
          status: 'succeeded',
          outcome: { status: 'success', summary: 'applied', content: '{"success":true}', httpStatus: 200 },
        }),
      ),
    ).toEqual({ kind: 'answer', status: 200, body: '{"success":true}' });
  });

  it('answers a success whose content was withheld without the content', () => {
    const answer = cloudflareChangeAnswer(
      state({
        status: 'succeeded',
        outcome: { status: 'success', summary: 'Withheld.', httpStatus: 200, sensitiveContentWithheld: true },
      }),
    );
    expect(answer).toMatchObject({ kind: 'answer', status: 200 });
    expect(answer.kind === 'answer' && JSON.parse(answer.body)).toMatchObject({ success: true, result: null });
  });

  it.each([
    ['rejected', 'The person declined this change'],
    ['expired', 'No one approved this change in time'],
  ] as const)('says nothing was sent when the change was %s', (status, said) => {
    const answer = cloudflareChangeAnswer(state({ status }));
    expect(answer).toMatchObject({ kind: 'answer', status: 403 });
    expect(message(answer)).toContain(said);
    expect(message(answer)).toContain('nothing was sent');
  });

  it("passes on Cloudflare's error when the change failed", () => {
    const error = '{"success":false,"errors":[{"code":7003,"message":"No route"}]}';
    expect(
      cloudflareChangeAnswer(
        state({ status: 'failed', outcome: { status: 'failure', summary: error, httpStatus: 404 } }),
      ),
    ).toEqual({ kind: 'answer', status: 404, body: error });
  });
});

type TestSqlResult = TestRow[] & { rowsWritten: number };

function result(rows: TestRow[], rowsWritten = 0): TestSqlResult {
  return Object.assign(rows, { rowsWritten });
}
