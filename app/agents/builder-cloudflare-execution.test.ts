import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CLOUDFLARE_EXECUTION_APPROVAL_TTL_MS,
  type CloudflareExecutionPublicState,
} from 'cloudchef-agent/cloudflare-api';
import { BUILDER_TOOL_DEADLINES_MS } from '~/lib/.server/llm/builder-turn-limits';
import {
  BuilderCloudflareExecutionRepository,
  cloudflareChangeAnswer,
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
  left_waiting_at: number | null;
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
        const rows = [...this.rows.values()]
          .filter((candidate) => candidate.tool_call_id === bindings[0])
          .sort((left, right) => left.created_at - right.created_at);
        return result(rows);
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
          left_waiting_at: null,
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
        const written = row?.status === 'awaiting_approval' && row.left_waiting_at === null;
        if (row && written) {
          row.status = 'expired';
          row.completed_at = Number(bindings[0]);
          row.outcome_json = String(bindings[1]);
        }
        return result([], written ? 1 : 0);
      }
      if (normalized.includes('SET left_waiting_at = ?') && normalized.includes('WHERE execution_id = ?')) {
        const row = this.rows.get(String(bindings[1]));
        const written = row?.status === 'awaiting_approval' && row.left_waiting_at === null;
        if (row && written) {
          row.left_waiting_at = Number(bindings[0]);
        }
        return result([], written ? 1 : 0);
      }
      if (normalized.includes('SET left_waiting_at = ?')) {
        let written = 0;
        for (const row of this.rows.values()) {
          if (
            row.status === 'awaiting_approval' &&
            row.left_waiting_at === null &&
            row.expires_at <= Number(bindings[1])
          ) {
            row.left_waiting_at = Number(bindings[0]);
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
    conversationIndex: 0,
    parentAgentName: null,
  },
};

function executionRepository(storage = new TestExecutionStorage()) {
  // SAFETY: the repository exercises only synchronous SQL iteration, rowsWritten, and
  // transactionSync; this test double implements those exact members for every emitted query.
  return { storage, repository: new ProposingRepository(storage as never) };
}

/** The repository, whose proposals in these tests are each the first waiting in their command. */
class ProposingRepository extends BuilderCloudflareExecutionRepository {
  override async createProposal(...args: Parameters<BuilderCloudflareExecutionRepository['createProposal']>) {
    const proposal = await super.createProposal(...args);
    if (!proposal) {
      throw new Error('An earlier change of this command still waits.');
    }
    return proposal;
  }

  /** What the repository itself answers, a change queued behind another of its command among them. */
  propose(...args: Parameters<BuilderCloudflareExecutionRepository['createProposal']>) {
    return super.createProposal(...args);
  }
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
    ['transcript', { transcript: { ...binding.transcript, conversationIndex: 1 } }],
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

  it('waits inside its command until just before exec’s deadline, then waits in the chat and can still be approved', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'tool-4',
      binding,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old' },
    });
    expect(proposal.expiresAt - proposal.createdAt).toBe(CLOUDFLARE_EXECUTION_APPROVAL_TTL_MS);
    expect(CLOUDFLARE_EXECUTION_APPROVAL_TTL_MS).toBeLessThan(BUILDER_TOOL_DEADLINES_MS.exec);
    expect(CLOUDFLARE_EXECUTION_APPROVAL_TTL_MS).toBeGreaterThanOrEqual(BUILDER_TOOL_DEADLINES_MS.exec - 2 * 60_000);

    vi.useFakeTimers({ toFake: ['Date'], now: proposal.expiresAt + 6 * 60 * 60_000 });
    const { record } = await repository.approve(proposal.executionId, binding);
    expect(record).toMatchObject({ status: 'approved', leftWaitingAt: proposal.expiresAt + 6 * 60 * 60_000 });
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

  it("queues a command's next change until the one before it is settled, then waits for its own decision", async () => {
    const { repository } = executionRepository();
    const other = { ...deleteSite, url: deleteSite.url.replace('site', 'other') };
    const first = await repository.createProposal({ toolCallId: 'exec-1', binding, request: deleteSite });

    // Each change of a command is approved in turn: the next one waits its turn, even the same request again.
    await expect(repository.propose({ toolCallId: 'exec-1', binding, request: other })).resolves.toBeNull();
    await expect(repository.propose({ toolCallId: 'exec-1', binding, request: deleteSite })).resolves.toBeNull();
    // Another command's change waits on its own.
    await expect(repository.propose({ toolCallId: 'exec-2', binding, request: other })).resolves.not.toBeNull();

    await repository.reject(first.executionId, binding);
    const second = await repository.propose({ toolCallId: 'exec-1', binding, request: other });
    expect(second).toMatchObject({ toolCallId: 'exec-1', status: 'awaiting_approval', request: other });
    expect(second?.executionId).not.toBe(first.executionId);
  });

  it('leaves only the change a stopped cf waited for in the chat, when named', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({ toolCallId: 'exec-1', binding, request: deleteSite });

    expect(repository.leaveInChat('exec-1', 'another-execution')).toBe(false);
    expect(repository.get(proposal.executionId)?.leftWaitingAt).toBeNull();
    expect(repository.leaveInChat('exec-1', proposal.executionId)).toBe(true);
    expect(repository.get(proposal.executionId)).toMatchObject({
      status: 'awaiting_approval',
      leftWaitingAt: expect.any(Number),
    });
  });

  it('keeps the change of a command that finished before anyone decided waiting in the chat, to approve later', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({ toolCallId: 'exec-1', binding, request: deleteSite });

    expect(repository.leaveInChat('exec-1')).toBe(true);
    expect(repository.leaveInChat('exec-1')).toBe(false);
    expect(repository.leftInChatBy('exec-1').map((record) => record.executionId)).toEqual([proposal.executionId]);
    // It no longer holds up the command's next change.
    await expect(repository.propose({ toolCallId: 'exec-1', binding, request: deleteSite })).resolves.not.toBeNull();
    await expect(repository.approve(proposal.executionId, binding)).resolves.toMatchObject({ transitioned: true });
  });

  it('withdraws the change a stopped command still held, but not one already waiting in the chat', async () => {
    const { repository } = executionRepository();
    const inChat = await repository.createProposal({ toolCallId: 'exec-1', binding, request: deleteSite });
    repository.leaveInChat('exec-1');
    const held = await repository.createProposal({ toolCallId: 'exec-1', binding, request: deleteSite });

    expect(repository.withdrawHeld('exec-1')).toBe(true);
    const withdrawn = repository.get(held.executionId)!;
    expect(withdrawn.status).toBe('expired');
    expect(withdrawn.outcome?.summary).toContain('The command was stopped before anyone approved the change');
    await expect(repository.approve(held.executionId, binding)).rejects.toThrow('can no longer be approved');
    expect(repository.get(inChat.executionId)?.status).toBe('awaiting_approval');
  });

  it('leaves nothing in the chat once a change was approved', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({ toolCallId: 'exec-1', binding, request: deleteSite });
    await repository.approve(proposal.executionId, binding);

    expect(repository.leaveInChat('exec-1')).toBe(false);
    expect(repository.withdrawHeld('exec-1')).toBe(false);
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
    leftWaitingAt: null,
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

  it('tells cf plainly that a change left waiting in the chat is not made yet, and will be when approved', () => {
    const answer = cloudflareChangeAnswer(state({ status: 'awaiting_approval', leftWaitingAt: 3 }));
    expect(answer).toMatchObject({ kind: 'answer', status: 202 });
    expect(message(answer)).toBe(
      'Not changed yet: waiting for your approval in the chat. It will be sent when you approve it.',
    );
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
