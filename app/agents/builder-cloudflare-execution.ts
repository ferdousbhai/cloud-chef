import {
  CLOUDFLARE_EXECUTION_APPROVAL_TTL_MS,
  cloudflareApiRequestSchema,
  type CloudflareApiRequest,
  type CloudflareExecutionPublicState,
  type CloudflareExecutionSafeOutcome,
  type CloudflareExecutionStatus,
} from 'cloudchef-agent/cloudflare-api';
import { sha256Hex } from '~/lib/hex-digest';
import type { RuntimeConnectionIdentity } from '~/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import { builderTranscriptBindingsEqual, type BuilderTranscriptBinding } from './builder-request-policy';
import { z } from 'zod';

type CloudflareExecutionStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

export type CloudflareExecutionBinding = Pick<
  RuntimeConnectionIdentity,
  'userId' | 'accountId' | 'connectionId' | 'connectionGeneration'
> & {
  transcript: BuilderTranscriptBinding;
};

export type CloudflareExecutionRecord = CloudflareExecutionPublicState & {
  binding: CloudflareExecutionBinding;
  request: CloudflareApiRequest;
};

type CloudflareExecutionRow = {
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
  status: string;
  created_at: number;
  decided_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  expires_at: number;
  outcome_json: string | null;
};

const EXECUTION_COLUMNS = `execution_id, tool_call_id, user_id, account_id, connection_id,
  connection_generation, transcript_agent_name, transcript_chat_initial_id,
  transcript_subchat_index, transcript_parent_agent_name, execute_input_json, proposal_sha256,
  status, created_at, decided_at, started_at, completed_at, expires_at, outcome_json`;

export const CLOUDFLARE_EXECUTION_RISK_NOTE =
  'This request changes your Cloudflare account and may be destructive, irreversible, or billable. Approval sends this exact request once.';

/** Stored with each proposal for the audit trail; a single request carries one reason. */
const RISK_REASONS_JSON = JSON.stringify([
  'Cloudflare changes can be externally visible, destructive, irreversible, or billable.',
]);

const credentialishPatterns: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}\b/u,
  /["'](?:access_?token|api_?key|client_?secret|password|private_?key|refresh_?token|secret)["']\s*:/iu,
  /\b(?:access_?token|api_?key|client_?secret|password|private_?key|refresh_?token|secret)\s*[=:]\s*[^\s,}]{8,}/iu,
];

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
class CloudflareExecutionDecisionError extends Error {
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
    request: CloudflareApiRequest;
  }): Promise<CloudflareExecutionRecord> {
    const now = Date.now();
    const inputJson = JSON.stringify(args.request);
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
           -- Neither is read: every connection holds the whole core grant, and transcripts have no generation.
           oauth_scope_grant_status,
           transcript_agent_name, transcript_chat_initial_id, transcript_generation,
           transcript_subchat_index, transcript_parent_agent_name, execute_input_json,
           proposal_sha256, risk_reasons_json, status, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'core', ?, ?, 0, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?)`,
        executionId,
        args.toolCallId,
        args.binding.userId,
        args.binding.accountId,
        args.binding.connectionId,
        args.binding.connectionGeneration,
        args.binding.transcript.agentName,
        args.binding.transcript.chatInitialId,
        args.binding.transcript.subchatIndex,
        args.binding.transcript.parentAgentName,
        inputJson,
        proposalSha256,
        RISK_REASONS_JSON,
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

  listRecent(): CloudflareExecutionPublicState[] {
    return [
      ...this.storage.sql.exec<CloudflareExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS}
         FROM builder_cloudflare_executions
         ORDER BY created_at DESC, execution_id DESC
         LIMIT 20`,
      ),
    ].map((row) => publicExecutionState(recordFromRow(row)));
  }

  async approve(
    executionId: string,
    binding: CloudflareExecutionBinding,
  ): Promise<{ record: CloudflareExecutionRecord; transitioned: boolean }> {
    const now = Date.now();
    await this.verify(executionId, binding);
    let transitioned = false;
    const record = this.storage.transactionSync(() => {
      const current = this.require(executionId);
      // The status and expiry were just read inside this synchronous transaction, so they decide the
      // transition. A SQL cursor's rowsWritten is not final until the cursor is consumed.
      if (current.status === 'awaiting_approval' && current.expiresAt > now) {
        this.storage.sql.exec(
          `UPDATE builder_cloudflare_executions SET status = 'approved', decided_at = ? WHERE execution_id = ?`,
          now,
          executionId,
        );
        transitioned = true;
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
  ): Promise<{ record: CloudflareExecutionRecord; transitioned: boolean }> {
    const now = Date.now();
    await this.verify(executionId, binding);
    const denied: CloudflareExecutionSafeOutcome = {
      status: 'denied',
      summary: 'The user rejected this Cloudflare execution.',
    };
    let transitioned = false;
    const record = this.storage.transactionSync(() => {
      const current = this.require(executionId);
      if (current.status === 'awaiting_approval' && current.expiresAt > now) {
        this.storage.sql.exec(
          `UPDATE builder_cloudflare_executions
           SET status = 'rejected', decided_at = ?, completed_at = ?, outcome_json = ?
           WHERE execution_id = ?`,
          now,
          now,
          JSON.stringify(denied),
          executionId,
        );
        transitioned = true;
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
  ): Promise<CloudflareExecutionRecord | null> {
    const now = Date.now();
    await this.verify(executionId, binding);
    return this.storage.transactionSync(() => {
      const current = this.require(executionId);
      if (current.status !== 'approved') {
        return null;
      }
      this.storage.sql.exec(
        `UPDATE builder_cloudflare_executions SET status = 'executing', started_at = ? WHERE execution_id = ?`,
        now,
        executionId,
      );
      return this.require(executionId);
    });
  }

  complete(
    executionId: string,
    status: Extract<CloudflareExecutionStatus, 'succeeded' | 'failed' | 'indeterminate'>,
    outcome: CloudflareExecutionSafeOutcome,
  ): CloudflareExecutionRecord {
    const now = Date.now();
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

  failApproved(executionId: string, outcome: CloudflareExecutionSafeOutcome): CloudflareExecutionRecord {
    const now = Date.now();
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

  recoverIndeterminate(executionId: string, expectedProposalSha256: string): CloudflareExecutionRecord {
    const now = Date.now();
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

  expireAwaiting(): void {
    const now = Date.now();
    this.storage.sql.exec(
      `UPDATE builder_cloudflare_executions
       SET status = 'expired', completed_at = ?, outcome_json = ?
       WHERE status = 'awaiting_approval' AND expires_at <= ?`,
      now,
      JSON.stringify({ status: 'denied', summary: 'This Cloudflare execution approval expired.' }),
      now,
    );
  }

  /** The execution, provided it is still this binding's and still the proposal it was approved as. */
  async verify(executionId: string, binding: CloudflareExecutionBinding): Promise<CloudflareExecutionRecord> {
    this.expireAwaiting();
    const record = this.require(executionId);
    if (!executionBindingsEqual(record.binding, binding)) {
      throw new CloudflareExecutionDecisionError('The Cloudflare execution identity or connection changed.');
    }
    const digest = await proposalDigest(record.toolCallId, record.binding, JSON.stringify(record.request));
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
      transcript: {
        agentName: row.transcript_agent_name,
        chatInitialId: row.transcript_chat_initial_id,
        subchatIndex: row.transcript_subchat_index,
        parentAgentName: row.transcript_parent_agent_name,
      },
    },
    request: parseStoredRequest(row.execute_input_json),
  };
}

function parseStoredRequest(value: string): CloudflareApiRequest {
  const parsed = cloudflareApiRequestSchema.safeParse(JSON.parse(value));
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

const terminalExecutionStatuses = ['rejected', 'succeeded', 'failed', 'indeterminate', 'expired'] as const;

const executionStatusSchema = z.enum([
  'awaiting_approval',
  'approved',
  'executing',
  ...terminalExecutionStatuses,
]) satisfies z.ZodType<CloudflareExecutionStatus>;

export function isCloudflareExecutionTerminal(
  status: CloudflareExecutionStatus,
): status is (typeof terminalExecutionStatuses)[number] {
  return terminalExecutionStatuses.some((terminal) => terminal === status);
}

function parseStatus(value: string): CloudflareExecutionStatus {
  const status = executionStatusSchema.safeParse(value);
  if (!status.success) {
    throw new Error('Stored Cloudflare execution status is invalid.');
  }
  return status.data;
}

type CloudflareConnectionIdentity = Omit<CloudflareExecutionBinding, 'transcript'>;

/** Whether both are the same person on the same Cloudflare connection and generation. */
export function sameCloudflareConnectionIdentity(
  left: CloudflareConnectionIdentity,
  right: CloudflareConnectionIdentity,
): boolean {
  return (
    left.userId === right.userId &&
    left.accountId === right.accountId &&
    left.connectionId === right.connectionId &&
    left.connectionGeneration === right.connectionGeneration
  );
}

function executionBindingsEqual(left: CloudflareExecutionBinding, right: CloudflareExecutionBinding): boolean {
  return (
    sameCloudflareConnectionIdentity(left, right) && builderTranscriptBindingsEqual(left.transcript, right.transcript)
  );
}

function proposalDigest(toolCallId: string, binding: CloudflareExecutionBinding, inputJson: string): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      version: 3,
      toolName: 'cloudflare_request',
      toolCallId,
      userId: binding.userId,
      accountId: binding.accountId,
      connectionId: binding.connectionId,
      connectionGeneration: binding.connectionGeneration,
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
