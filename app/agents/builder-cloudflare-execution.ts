import {
  CLOUDFLARE_EXECUTION_APPROVAL_TTL_MS,
  type CloudflareExecutionPublicState,
  type CloudflareExecutionSafeOutcome,
  type CloudflareExecutionStatus,
} from 'cloudchef-agent/cloudflare-mcp';
import { sha256Hex } from '~/lib/hex-digest';
import type { CloudflareMcpRuntimeIdentity } from '~/lib/.server/cloudflare/cloudflare-mcp-runtime-controls';
import { builderTranscriptBindingsEqual, type BuilderTranscriptBinding } from './builder-request-policy';
import { z } from 'zod';

type CloudflareExecutionStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

export type CloudflareExecutionBinding = Pick<
  CloudflareMcpRuntimeIdentity,
  'userId' | 'accountId' | 'connectionId' | 'connectionGeneration' | 'oauthScopeGrantStatus'
> & {
  transcript: BuilderTranscriptBinding;
};

export type CloudflareExecutionRecord = CloudflareExecutionPublicState & {
  binding: CloudflareExecutionBinding;
  code: string;
};

type CloudflareExecutionRow = {
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
  status: string;
  created_at: number;
  decided_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  expires_at: number;
  outcome_json: string | null;
};

const EXECUTION_COLUMNS = `execution_id, tool_call_id, user_id, account_id, connection_id,
  connection_generation, oauth_scope_grant_status, transcript_agent_name, transcript_chat_initial_id, transcript_generation,
  transcript_subchat_index, transcript_parent_agent_name, execute_input_json, proposal_sha256,
  status, created_at, decided_at, started_at, completed_at, expires_at, outcome_json`;

export const CLOUDFLARE_EXECUTION_RISK_NOTE =
  'This generated code may make one or more Cloudflare API requests, including mutations, destructive changes, or billable actions. Approval authorizes this exact digest once.';

const DEFAULT_RISK_REASONS = [
  'Generated execute code can contain multiple API requests whose effects are not statically classified.',
  'Cloudflare changes can be externally visible, destructive, irreversible, or billable.',
] as const;

const credentialishPatterns: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}\b/u,
  /["'](?:access_?token|api_?key|client_?secret|password|private_?key|refresh_?token|secret)["']\s*:/iu,
  /\b(?:access_?token|api_?key|client_?secret|password|private_?key|refresh_?token|secret)\s*[=:]\s*[^\s,}]{8,}/iu,
];

const storedExecuteInputSchema = z.object({ code: z.string() }).strict();
const storedExecutionOutcomeSchema = z
  .object({
    status: z.enum(['success', 'failure', 'insufficient_scope', 'indeterminate', 'denied']),
    summary: z.string(),
    content: z.string().optional(),
    requestId: z.string().nullable().optional(),
    httpStatus: z.number().nullable().optional(),
    truncated: z.boolean().optional(),
    sensitiveContentWithheld: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<CloudflareExecutionSafeOutcome>;
export class CloudflareExecutionDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareExecutionDecisionError';
  }
}

export class BuilderCloudflareExecutionRepository {
  constructor(private readonly storage: CloudflareExecutionStorage) {}

  async createProposal(args: {
    toolCallId: string;
    binding: CloudflareExecutionBinding;
    code: string;
    now?: number;
  }): Promise<CloudflareExecutionRecord> {
    const now = args.now ?? Date.now();
    const inputJson = JSON.stringify({ code: args.code });
    const proposalSha256 = await proposalDigest(args.toolCallId, args.binding, inputJson);
    return this.storage.transactionSync(() => {
      const existing = this.findByToolCallId(args.toolCallId);
      if (existing) {
        if (existing.proposalSha256 !== proposalSha256 || !executionBindingsEqual(existing.binding, args.binding)) {
          throw new CloudflareExecutionDecisionError(
            'The Cloudflare tool-call identity was reused for another proposal.',
          );
        }
        return existing;
      }
      const executionId = crypto.randomUUID();
      const expiresAt = now + CLOUDFLARE_EXECUTION_APPROVAL_TTL_MS;
      this.storage.sql.exec(
        `INSERT INTO builder_cloudflare_executions (
           execution_id, tool_call_id, user_id, account_id, connection_id, connection_generation,
           oauth_scope_grant_status,
           transcript_agent_name, transcript_chat_initial_id, transcript_generation,
           transcript_subchat_index, transcript_parent_agent_name, execute_input_json,
           proposal_sha256, risk_reasons_json, status, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?)`,
        executionId,
        args.toolCallId,
        args.binding.userId,
        args.binding.accountId,
        args.binding.connectionId,
        args.binding.connectionGeneration,
        args.binding.oauthScopeGrantStatus,
        args.binding.transcript.agentName,
        args.binding.transcript.chatInitialId,
        args.binding.transcript.generation,
        args.binding.transcript.subchatIndex,
        args.binding.transcript.parentAgentName,
        inputJson,
        proposalSha256,
        JSON.stringify(DEFAULT_RISK_REASONS),
        now,
        expiresAt,
      );
      return this.require(executionId);
    });
  }

  get(executionId: string): CloudflareExecutionRecord | null {
    const row = first(
      this.storage.sql.exec<CloudflareExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS} FROM builder_cloudflare_executions WHERE execution_id = ? LIMIT 1`,
        executionId,
      ),
    );
    return row ? recordFromRow(row) : null;
  }

  verify(
    executionId: string,
    binding: CloudflareExecutionBinding,
    now = Date.now(),
  ): Promise<CloudflareExecutionRecord> {
    return this.requireBound(executionId, binding, now);
  }

  listRecent(limit = 20): CloudflareExecutionPublicState[] {
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    return [
      ...this.storage.sql.exec<CloudflareExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS}
         FROM builder_cloudflare_executions
         ORDER BY created_at DESC, execution_id DESC
         LIMIT ?`,
        boundedLimit,
      ),
    ].map((row) => publicExecutionState(recordFromRow(row)));
  }

  async approve(
    executionId: string,
    binding: CloudflareExecutionBinding,
    now = Date.now(),
  ): Promise<{ record: CloudflareExecutionRecord; transitioned: boolean }> {
    await this.requireBound(executionId, binding, now);
    let transitioned = false;
    const record = this.storage.transactionSync(() => {
      const current = this.require(executionId);
      if (current.status === 'awaiting_approval') {
        transitioned =
          this.storage.sql.exec(
            `UPDATE builder_cloudflare_executions
           SET status = 'approved', decided_at = ?
           WHERE execution_id = ? AND status = 'awaiting_approval' AND expires_at > ?`,
            now,
            executionId,
            now,
          ).rowsWritten === 1;
      }
      return this.require(executionId);
    });
    if (record.status === 'rejected' || record.status === 'expired') {
      throw new CloudflareExecutionDecisionError('This Cloudflare execution can no longer be approved.');
    }
    return { record, transitioned };
  }

  async reject(
    executionId: string,
    binding: CloudflareExecutionBinding,
    now = Date.now(),
  ): Promise<{ record: CloudflareExecutionRecord; transitioned: boolean }> {
    await this.requireBound(executionId, binding, now);
    const denied: CloudflareExecutionSafeOutcome = {
      status: 'denied',
      summary: 'The user rejected this Cloudflare execution.',
    };
    let transitioned = false;
    const record = this.storage.transactionSync(() => {
      const current = this.require(executionId);
      if (current.status === 'awaiting_approval') {
        transitioned =
          this.storage.sql.exec(
            `UPDATE builder_cloudflare_executions
           SET status = 'rejected', decided_at = ?, completed_at = ?, outcome_json = ?
           WHERE execution_id = ? AND status = 'awaiting_approval' AND expires_at > ?`,
            now,
            now,
            JSON.stringify(denied),
            executionId,
            now,
          ).rowsWritten === 1;
      }
      return this.require(executionId);
    });
    if (record.status !== 'rejected') {
      throw new CloudflareExecutionDecisionError('This Cloudflare execution can no longer be rejected.');
    }
    return { record, transitioned };
  }

  async beginExecution(
    executionId: string,
    binding: CloudflareExecutionBinding,
    now = Date.now(),
  ): Promise<CloudflareExecutionRecord | null> {
    await this.requireBound(executionId, binding, now);
    return this.storage.transactionSync(() => {
      const current = this.require(executionId);
      if (current.status !== 'approved') {
        return null;
      }
      const updated = this.storage.sql.exec(
        `UPDATE builder_cloudflare_executions
         SET status = 'executing', started_at = ?
         WHERE execution_id = ? AND status = 'approved'`,
        now,
        executionId,
      );
      return updated.rowsWritten === 1 ? this.require(executionId) : null;
    });
  }

  complete(
    executionId: string,
    status: Extract<CloudflareExecutionStatus, 'succeeded' | 'failed' | 'indeterminate'>,
    outcome: CloudflareExecutionSafeOutcome,
    now = Date.now(),
  ): CloudflareExecutionRecord {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE builder_cloudflare_executions
         SET status = ?, completed_at = ?, outcome_json = ?
         WHERE execution_id = ? AND status = 'executing'`,
        status,
        now,
        JSON.stringify(outcome),
        executionId,
      );
      return this.require(executionId);
    });
  }

  failApproved(
    executionId: string,
    outcome: CloudflareExecutionSafeOutcome,
    now = Date.now(),
  ): CloudflareExecutionRecord {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE builder_cloudflare_executions
         SET status = 'failed', completed_at = ?, outcome_json = ?
         WHERE execution_id = ? AND status = 'approved'`,
        now,
        JSON.stringify(outcome),
        executionId,
      );
      return this.require(executionId);
    });
  }

  recoverIndeterminate(
    executionId: string,
    expectedProposalSha256: string,
    now = Date.now(),
  ): CloudflareExecutionRecord {
    const outcome: CloudflareExecutionSafeOutcome = {
      status: 'indeterminate',
      summary:
        'The approved Cloudflare execution was interrupted. CloudChef will not replay it; reconcile with a read before proposing another mutation.',
    };
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE builder_cloudflare_executions
         SET status = 'indeterminate', completed_at = ?, outcome_json = ?
         WHERE execution_id = ? AND proposal_sha256 = ?
           AND status IN ('awaiting_approval', 'approved', 'executing')`,
        now,
        JSON.stringify(outcome),
        executionId,
        expectedProposalSha256,
      );
      return this.require(executionId);
    });
  }

  expireAwaiting(now = Date.now()): void {
    this.storage.sql.exec(
      `UPDATE builder_cloudflare_executions
       SET status = 'expired', completed_at = ?, outcome_json = ?
       WHERE status = 'awaiting_approval' AND expires_at <= ?`,
      now,
      JSON.stringify({ status: 'denied', summary: 'This Cloudflare execution approval expired.' }),
      now,
    );
  }

  private async requireBound(
    executionId: string,
    binding: CloudflareExecutionBinding,
    now: number,
  ): Promise<CloudflareExecutionRecord> {
    this.expireAwaiting(now);
    const record = this.require(executionId);
    if (!executionBindingsEqual(record.binding, binding)) {
      throw new CloudflareExecutionDecisionError('The Cloudflare execution identity or connection changed.');
    }
    const digest = await proposalDigest(record.toolCallId, record.binding, JSON.stringify({ code: record.code }));
    if (digest !== record.proposalSha256) {
      throw new CloudflareExecutionDecisionError('The stored Cloudflare execution digest does not match its proposal.');
    }
    return record;
  }

  private require(executionId: string): CloudflareExecutionRecord {
    const record = this.get(executionId);
    if (!record) {
      throw new CloudflareExecutionDecisionError('The Cloudflare execution does not exist.');
    }
    return record;
  }

  private findByToolCallId(toolCallId: string): CloudflareExecutionRecord | null {
    const row = first(
      this.storage.sql.exec<CloudflareExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS} FROM builder_cloudflare_executions WHERE tool_call_id = ? LIMIT 1`,
        toolCallId,
      ),
    );
    return row ? recordFromRow(row) : null;
  }
}

export function publicExecutionState(record: CloudflareExecutionRecord): CloudflareExecutionPublicState {
  return {
    executionId: record.executionId,
    toolCallId: record.toolCallId,
    accountId: record.accountId,
    proposalSha256: record.proposalSha256,
    status: record.status,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    expiresAt: record.expiresAt,
    outcome: record.outcome,
  };
}

export function containsCredentialishCloudflareContent(value: string): boolean {
  return credentialishPatterns.some((pattern) => pattern.test(value));
}

function recordFromRow(row: CloudflareExecutionRow): CloudflareExecutionRecord {
  const input = parseExecuteInput(row.execute_input_json);
  return {
    executionId: row.execution_id,
    toolCallId: row.tool_call_id,
    accountId: row.account_id,
    proposalSha256: row.proposal_sha256,
    status: parseStatus(row.status),
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    outcome: parseOutcome(row.outcome_json),
    binding: {
      userId: row.user_id,
      accountId: row.account_id,
      connectionId: row.connection_id,
      connectionGeneration: row.connection_generation,
      oauthScopeGrantStatus: parseGrantStatus(row.oauth_scope_grant_status),
      transcript: {
        agentName: row.transcript_agent_name,
        chatInitialId: row.transcript_chat_initial_id,
        generation: row.transcript_generation,
        subchatIndex: row.transcript_subchat_index,
        parentAgentName: row.transcript_parent_agent_name,
      },
    },
    code: input.code,
  };
}

function parseExecuteInput(value: string) {
  const parsed = storedExecuteInputSchema.safeParse(JSON.parse(value));
  if (!parsed.success) {
    throw new Error('Stored Cloudflare execution input is invalid.');
  }
  return parsed.data;
}

function parseOutcome(value: string | null): CloudflareExecutionSafeOutcome | null {
  if (value === null) {
    return null;
  }
  const parsed = storedExecutionOutcomeSchema.safeParse(JSON.parse(value));
  if (!parsed.success) {
    throw new Error('Stored Cloudflare execution outcome is invalid.');
  }
  return parsed.data;
}

function parseStatus(value: string): CloudflareExecutionStatus {
  if (
    value !== 'awaiting_approval' &&
    value !== 'approved' &&
    value !== 'rejected' &&
    value !== 'executing' &&
    value !== 'succeeded' &&
    value !== 'failed' &&
    value !== 'indeterminate' &&
    value !== 'expired'
  ) {
    throw new Error('Stored Cloudflare execution status is invalid.');
  }
  return value;
}

function executionBindingsEqual(left: CloudflareExecutionBinding, right: CloudflareExecutionBinding): boolean {
  return (
    left.userId === right.userId &&
    left.accountId === right.accountId &&
    left.connectionId === right.connectionId &&
    left.connectionGeneration === right.connectionGeneration &&
    left.oauthScopeGrantStatus === right.oauthScopeGrantStatus &&
    builderTranscriptBindingsEqual(left.transcript, right.transcript)
  );
}

function proposalDigest(toolCallId: string, binding: CloudflareExecutionBinding, inputJson: string): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      version: 1,
      toolName: 'execute',
      toolCallId,
      userId: binding.userId,
      accountId: binding.accountId,
      connectionId: binding.connectionId,
      connectionGeneration: binding.connectionGeneration,
      oauthScopeGrantStatus: binding.oauthScopeGrantStatus,
      transcript: binding.transcript,
      input: JSON.parse(inputJson),
    }),
  );
}

function first<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) {
    return row;
  }
  return undefined;
}

function parseGrantStatus(value: string): CloudflareExecutionBinding['oauthScopeGrantStatus'] {
  if (value !== 'core' && value !== 'partial' && value !== 'full') {
    throw new Error('Stored Cloudflare execution grant status is invalid.');
  }
  return value;
}
