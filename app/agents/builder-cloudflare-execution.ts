import {
  CLOUDFLARE_CHANGE_WAITING_IN_CHAT,
  CLOUDFLARE_EXECUTION_APPROVAL_TTL_MS,
  cloudflareApiRequestSchema,
  type CloudflareApiRequest,
  type CloudflareChangeWaitingInChat,
  type CloudflareExecutionPublicState,
  type CloudflareRequestFinalResult,
  type CloudflareExecutionSafeOutcome,
  type CloudflareExecutionStatus,
} from 'cloudchef-agent/cloudflare-api';
import { sha256Hex } from '~/lib/hex-digest';
import { cloudflareApiErrorBody, type CloudflareChangeAnswer } from '~/lib/.server/cloudflare/cloudflare-api-proxy';
import type { CloudflareApiOutcome } from '~/lib/.server/cloudflare/cloudflare-api-client';
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
  left_waiting_at: number | null;
  outcome_json: string | null;
  risk_reasons_json: string;
};

const EXECUTION_COLUMNS = `execution_id, tool_call_id, user_id, account_id, connection_id,
  connection_generation, transcript_agent_name, transcript_chat_initial_id,
  transcript_subchat_index, transcript_parent_agent_name, execute_input_json, proposal_sha256,
  status, created_at, decided_at, started_at, completed_at, expires_at, left_waiting_at, outcome_json, risk_reasons_json`;

const CLOUDFLARE_EXECUTION_RISK_NOTE =
  'This changes your Cloudflare account, and may delete something, be hard to undo, or cost money. Approving sends exactly this request once.';

/** Stored with each proposal for the audit trail: why it needs approval, and CloudChef's note on what it does. */
const RISK_REASON = 'Cloudflare changes can be externally visible, destructive, irreversible, or billable.';
const riskReasonsSchema = z.array(z.string());
const EXPIRED_SUMMARY = 'No one approved this change in time, so nothing was sent to Cloudflare.';
const STOPPED_SUMMARY = 'The command was stopped before anyone approved the change, so nothing was sent to Cloudflare.';

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

  /**
   * A change the command `toolCallId` asked for, waiting for the person. A command may ask for several, each waiting
   * in turn in its card: null while an earlier one of the same command is still waiting or being sent, so this one
   * is asked for again once that is settled.
   */
  async createProposal(args: {
    toolCallId: string;
    binding: CloudflareExecutionBinding;
    request: CloudflareApiRequest;
    /** CloudChef's plain-words note on what the change does, shown with it. */
    warning?: string | null;
  }): Promise<CloudflareExecutionRecord | null> {
    const now = Date.now();
    const inputJson = JSON.stringify(args.request);
    const proposalSha256 = await proposalDigest(args.toolCallId, args.binding, inputJson);
    this.leaveOverdueInChat();
    return this.storage.transactionSync(() => {
      if (this.unsettledFor(args.toolCallId)) {
        return null;
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
        JSON.stringify(args.warning ? [RISK_REASON, args.warning] : [RISK_REASON]),
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
      if (decidable(current, now)) {
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
      if (decidable(current, now)) {
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

  /**
   * The command that asked was stopped (by the person, or because its turn ended) while `cf` still waited for a
   * change: nothing would read its answer, so it is never sent. A change already left waiting in the chat stays
   * there. Answers whether one was withdrawn.
   */
  withdrawHeld(toolCallId: string): boolean {
    const now = Date.now();
    const outcome: CloudflareExecutionSafeOutcome = { status: 'denied', summary: STOPPED_SUMMARY };
    return this.storage.transactionSync(() => {
      const held = this.awaitingFor(toolCallId).filter((record) => record.leftWaitingAt === null);
      for (const record of held) {
        this.storage.sql.exec(
          `UPDATE builder_cloudflare_executions
           SET status = 'expired', completed_at = ?, outcome_json = ?
           WHERE execution_id = ? AND status = 'awaiting_approval' AND left_waiting_at IS NULL`,
          now,
          JSON.stringify(outcome),
          record.executionId,
        );
      }
      return held.length > 0;
    });
  }

  /**
   * The command that asked no longer waits for a change still waiting for the person (or for `executionId`, when
   * named): it finished, `cf` stopped, or the proxy stopped asking. It goes on waiting in the chat, with no deadline,
   * and is sent once if the person approves it. Answers whether one was left so.
   */
  leaveInChat(toolCallId: string, executionId?: string): boolean {
    const now = Date.now();
    return this.storage.transactionSync(() => {
      const held = this.awaitingFor(toolCallId).filter(
        (record) => record.leftWaitingAt === null && (executionId === undefined || record.executionId === executionId),
      );
      for (const record of held) {
        this.storage.sql.exec(
          `UPDATE builder_cloudflare_executions SET left_waiting_at = ?
           WHERE execution_id = ? AND status = 'awaiting_approval' AND left_waiting_at IS NULL`,
          now,
          record.executionId,
        );
      }
      return held.length > 0;
    });
  }

  /**
   * A change still undecided when its command's wait runs out is left waiting in the chat: `cf` is told so, and the
   * command goes on.
   */
  leaveOverdueInChat(): void {
    const now = Date.now();
    this.storage.sql.exec(
      `UPDATE builder_cloudflare_executions SET left_waiting_at = ?
       WHERE status = 'awaiting_approval' AND left_waiting_at IS NULL AND expires_at <= ?`,
      now,
      now,
    );
  }

  /** The changes of the command `toolCallId` that it left waiting in the chat, whatever became of them since. */
  leftInChatBy(toolCallId: string): CloudflareExecutionRecord[] {
    return this.changesOf(toolCallId).filter((record) => record.leftWaitingAt !== null);
  }

  /** The execution, provided it is still this binding's and still the proposal it was approved as. */
  async verify(executionId: string, binding: CloudflareExecutionBinding): Promise<CloudflareExecutionRecord> {
    this.leaveOverdueInChat();
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

  /**
   * Whether a change of the command `toolCallId` still waits for the person inside the command, or is being sent;
   * one the command left waiting in the chat no longer holds up its next change.
   */
  private unsettledFor(toolCallId: string): boolean {
    return this.changesOf(toolCallId).some(
      (record) =>
        !isCloudflareExecutionTerminal(record.status) &&
        !(record.status === 'awaiting_approval' && record.leftWaitingAt !== null),
    );
  }

  private awaitingFor(toolCallId: string): CloudflareExecutionRecord[] {
    return this.changesOf(toolCallId).filter((record) => record.status === 'awaiting_approval');
  }

  private changesOf(toolCallId: string): CloudflareExecutionRecord[] {
    return [
      ...this.storage.sql.exec<CloudflareExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS} FROM builder_cloudflare_executions WHERE tool_call_id = ? ORDER BY created_at`,
        toolCallId,
      ),
    ].map(recordFromRow);
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
    leftWaitingAt: record.leftWaitingAt,
    outcome: record.outcome,
    request: record.request,
    riskNote: record.riskNote,
  };
}

function containsCredentialishCloudflareContent(value: string): boolean {
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
    leftWaitingAt: row.left_waiting_at,
    outcome: parseOutcome(row.outcome_json),
    riskNote: riskNote(row.risk_reasons_json),
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

function riskNote(value: string): string {
  const parsed = riskReasonsSchema.safeParse(JSON.parse(value));
  const warning = parsed.success ? parsed.data[1] : undefined;
  return warning ? `${warning} ${CLOUDFLARE_EXECUTION_RISK_NOTE}` : CLOUDFLARE_EXECUTION_RISK_NOTE;
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

/**
 * Whether the person may still decide: it waits, and either its command still waits for it within its time or it
 * waits in the chat, which has no deadline.
 */
function decidable(record: CloudflareExecutionRecord, now: number): boolean {
  return record.status === 'awaiting_approval' && (record.leftWaitingAt !== null || record.expiresAt > now);
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

/** What is kept of an approved change's answer: sensitive-looking content is withheld. */
export function safeCloudflareExecutionOutcome(outcome: CloudflareApiOutcome): CloudflareExecutionSafeOutcome {
  const metadata = { requestId: outcome.requestId, httpStatus: outcome.httpStatus, truncated: outcome.truncated };
  if (outcome.status === 'success') {
    if (containsCredentialishCloudflareContent(outcome.content)) {
      return {
        status: 'success',
        summary: 'Cloudflare applied the approved request, but sensitive-looking response content was withheld.',
        ...metadata,
        sensitiveContentWithheld: true,
      };
    }
    return {
      status: 'success',
      summary: 'Cloudflare applied the approved request.',
      content: outcome.content,
      ...metadata,
    };
  }
  return { status: outcome.status, summary: outcome.content, ...metadata };
}

export function cloudflareExecutionStatusForOutcome(
  outcome: CloudflareApiOutcome,
): Extract<CloudflareExecutionStatus, 'succeeded' | 'failed' | 'indeterminate'> {
  return outcome.status === 'success' ? 'succeeded' : outcome.status === 'indeterminate' ? 'indeterminate' : 'failed';
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

/**
 * A change its command left waiting in the chat, as the command's output gives it to the agent: still waiting for
 * the person, or what they decided and, when it was sent, what Cloudflare answered.
 */
export function chatCloudflareChange(
  record: CloudflareExecutionPublicState,
): CloudflareChangeWaitingInChat | CloudflareRequestFinalResult {
  if (!isCloudflareExecutionTerminal(record.status)) {
    return {
      kind: 'cloudflare_change_waiting_in_chat',
      executionId: record.executionId,
      accountId: record.accountId,
      request: record.request,
      note:
        'Not changed yet: it waits for the person’s approval in the chat, and is sent once when they approve it. ' +
        'What they decide, and what Cloudflare answers, replaces this.',
    };
  }
  return {
    kind: 'cloudflare_request_final_result',
    executionId: record.executionId,
    accountId: record.accountId,
    proposalSha256: record.proposalSha256,
    status: record.status,
    outcome:
      record.status === 'rejected'
        ? { status: 'denied', summary: 'The person rejected this change, so nothing was sent to Cloudflare.' }
        : (record.outcome ?? { status: 'denied', summary: EXPIRED_SUMMARY }),
  };
}

/**
 * What `cf` is answered while a change waits or once it is settled: Cloudflare's own answer when it was sent (its
 * content withheld when it looked like it held a secret), or why nothing was sent, in Cloudflare's error shape.
 */
export function cloudflareChangeAnswer(record: CloudflareExecutionPublicState): CloudflareChangeAnswer {
  const outcome = record.outcome;
  switch (record.status) {
    case 'awaiting_approval':
      // Left waiting in the chat: `cf` is told so at once, and its command goes on.
      return record.leftWaitingAt === null
        ? { kind: 'waiting', executionId: record.executionId }
        : { kind: 'answer', status: 202, body: cloudflareApiErrorBody(CLOUDFLARE_CHANGE_WAITING_IN_CHAT) };
    case 'approved':
    case 'executing':
      return { kind: 'waiting', executionId: record.executionId };
    case 'succeeded':
      return {
        kind: 'answer',
        status: outcome?.httpStatus ?? 200,
        body:
          outcome?.content ??
          JSON.stringify({
            success: true,
            errors: [],
            messages: [{ code: 10000, message: outcome?.summary ?? 'Cloudflare applied the change.' }],
            result: null,
          }),
      };
    case 'failed':
      return {
        kind: 'answer',
        status: outcome?.httpStatus ?? 502,
        body: isJson(outcome?.summary)
          ? outcome!.summary
          : cloudflareApiErrorBody(outcome?.summary ?? 'The change failed.'),
      };
    case 'indeterminate':
      return {
        kind: 'answer',
        status: 502,
        body: cloudflareApiErrorBody(
          outcome?.summary ??
            'Whether Cloudflare applied the change is unknown. Read the current state before retrying.',
        ),
      };
    case 'rejected':
      return {
        kind: 'answer',
        status: 403,
        body: cloudflareApiErrorBody('The person declined this change, so nothing was sent to Cloudflare.'),
      };
    case 'expired':
      return {
        kind: 'answer',
        status: 403,
        body: cloudflareApiErrorBody(outcome?.summary ?? EXPIRED_SUMMARY),
      };
  }
}

function isJson(value: string | undefined): value is string {
  if (value === undefined) {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function proposalDigest(toolCallId: string, binding: CloudflareExecutionBinding, inputJson: string): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      version: 4,
      // Asked for by `cf` in the command `toolCallId`, through the workspace's Cloudflare API proxy.
      source: 'workspace-command',
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
