import { describe, expect, it } from 'vitest';
import {
  BuilderCloudflareExecutionRepository,
  CloudflareExecutionDecisionError,
  type CloudflareExecutionBinding,
} from './builder-cloudflare-execution';

type TestRow = {
  execution_id: string;
  tool_call_id: string;
  user_id: string;
  account_id: string;
  connection_id: string;
  connection_generation: number;
  oauth_scope_grant_status: string;
  transcript_agent_name: string;
  transcript_chat_initial_id: string;
  transcript_generation: number;
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
          oauth_scope_grant_status: String(bindings[6]),
          transcript_agent_name: String(bindings[7]),
          transcript_chat_initial_id: String(bindings[8]),
          transcript_generation: Number(bindings[9]),
          transcript_subchat_index: Number(bindings[10]),
          transcript_parent_agent_name: bindings[11] === null ? null : String(bindings[11]),
          execute_input_json: String(bindings[12]),
          proposal_sha256: String(bindings[13]),
          risk_reasons_json: String(bindings[14]),
          status: 'awaiting_approval',
          created_at: Number(bindings[15]),
          decided_at: null,
          started_at: null,
          completed_at: null,
          expires_at: Number(bindings[16]),
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
  oauthScopeGrantStatus: 'full',
  transcript: {
    agentName: 'chat--transcript-0-1',
    chatInitialId: 'chat',
    generation: 1,
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
  it('admits duplicate approvals but claims execution exactly once', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'tool-1',
      binding,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old' },
      now: 100,
    });

    const approvals = await Promise.all([
      repository.approve(proposal.executionId, binding, 200),
      repository.approve(proposal.executionId, binding, 200),
    ]);
    expect(approvals.filter((approval) => approval.transitioned)).toHaveLength(1);

    const claims = await Promise.all([
      repository.beginExecution(proposal.executionId, binding, 300),
      repository.beginExecution(proposal.executionId, binding, 300),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const completed = repository.complete(
      proposal.executionId,
      'succeeded',
      { status: 'success', summary: 'done' },
      400,
    );
    expect(completed.status).toBe('succeeded');
    await expect(repository.beginExecution(proposal.executionId, binding, 500)).resolves.toBeNull();
  });

  it.each([
    ['user', { userId: 'user-2' }],
    ['account', { accountId: 'account-2' }],
    ['connection', { connectionId: 'connection-2' }],
    ['generation', { connectionGeneration: 5 }],
    ['grant', { oauthScopeGrantStatus: 'partial' as const }],
    ['transcript', { transcript: { ...binding.transcript, generation: 2 } }],
  ])('rejects a %s identity mismatch', async (_label, changed) => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'tool-2',
      binding,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old' },
      now: 100,
    });
    await expect(repository.approve(proposal.executionId, { ...binding, ...changed }, 200)).rejects.toBeInstanceOf(
      CloudflareExecutionDecisionError,
    );
  });

  it('rejects a stored proposal digest mismatch', async () => {
    const { repository, storage } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'tool-3',
      binding,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old' },
      now: 100,
    });
    const row = storage.rows.get(proposal.executionId);
    if (!row) {
      throw new Error('Test proposal row was not stored.');
    }
    row.proposal_sha256 = 'b'.repeat(64);

    await expect(repository.approve(proposal.executionId, binding, 200)).rejects.toThrow(
      'stored Cloudflare execution digest',
    );
  });

  it('expires awaiting approvals and prevents a late decision', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'tool-4',
      binding,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old' },
      now: 100,
    });

    await expect(repository.approve(proposal.executionId, binding, proposal.expiresAt)).rejects.toThrow(
      'can no longer be approved',
    );
    expect(repository.get(proposal.executionId)?.status).toBe('expired');
  });

  it('terminalizes recovered approval fibers as indeterminate and never claims them afterward', async () => {
    const { repository } = executionRepository();
    const proposal = await repository.createProposal({
      toolCallId: 'tool-5',
      binding,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old' },
      now: 100,
    });
    await repository.approve(proposal.executionId, binding, 200);
    await repository.beginExecution(proposal.executionId, binding, 300);

    const recovered = repository.recoverIndeterminate(proposal.executionId, proposal.proposalSha256, 400);
    expect(recovered.status).toBe('indeterminate');
    expect(recovered.outcome?.status).toBe('indeterminate');
    await expect(repository.beginExecution(proposal.executionId, binding, 500)).resolves.toBeNull();
  });
});

type TestSqlResult = TestRow[] & { rowsWritten: number };

function result(rows: TestRow[], rowsWritten = 0): TestSqlResult {
  return Object.assign(rows, { rowsWritten });
}
