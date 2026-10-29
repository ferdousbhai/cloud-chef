import { z } from 'zod';
import {
  cloudflareApiRequestSchema,
  type CloudflareApiRequest,
  type CloudflareExecutionSafeOutcome,
} from 'cloudchef-agent/cloudflare-api';

/** What became of a sent change. */
type ApprovalResult = 'succeeded' | 'failed' | 'indeterminate';
type ApprovalStatus = 'pending' | 'sending' | 'done' | 'rejected' | 'expired';
/** Where a change came from: a command the member's agent ran, or the member's own workspace terminal. */
type ApprovalSource = 'agent' | 'terminal';

/** A request as the team's admins see it on the Approvals page. */
type ApprovalRequest = {
  id: string;
  orgId: string;
  orgName: string;
  kind: 'cloudflare_change';
  source: ApprovalSource;
  requester: { name: string; email: string };
  request: CloudflareApiRequest;
  warning: string | null;
  status: ApprovalStatus;
  result: ApprovalResult | null;
  outcome: CloudflareExecutionSafeOutcome | null;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
  expiresAt: number;
};

/** A request as CloudChef sends it, and where its result goes back to (no conversation, for one from a terminal). */
type ClaimedRequest = {
  id: string;
  orgId: string;
  connectionId: string;
  requestedBy: string;
  agentName: string | null;
  request: CloudflareApiRequest;
};

type ApprovalRow = {
  id: string;
  org_id: string;
  org_name: string;
  kind: 'cloudflare_change';
  source: ApprovalSource;
  requester_name: string;
  requester_email: string;
  request_json: string;
  warning: string | null;
  status: ApprovalStatus;
  result: ApprovalResult | null;
  outcome_json: string | null;
  decider_name: string | null;
  decided_at: number | null;
  created_at: number;
  expires_at: number;
};

const outcomeSchema = z.object({
  status: z.enum(['success', 'failure', 'insufficient_scope', 'indeterminate', 'denied']),
  summary: z.string(),
  content: z.string().optional(),
  requestId: z.string().nullable().optional(),
  httpStatus: z.number().nullable().optional(),
  truncated: z.boolean().optional(),
  sensitiveContentWithheld: z.boolean().optional(),
}) satisfies z.ZodType<CloudflareExecutionSafeOutcome>;

/** Whoever asked is still in the team and not paused: a request from someone who left is never sent. */
const REQUESTER_IS_MEMBER = `EXISTS (
  SELECT 1 FROM organization_members AS requester
  WHERE requester.org_id = approval_requests.org_id AND requester.user_id = approval_requests.requested_by
    AND requester.paused_at IS NULL
)`;

/** `?actor` is one of the team's active admins. */
const ACTOR_IS_ADMIN = (actor: string) => `EXISTS (
  SELECT 1 FROM organization_members AS admins
  WHERE admins.org_id = approval_requests.org_id AND admins.user_id = ${actor} AND admins.role = 'admin'
    AND admins.paused_at IS NULL
)`;

/**
 * Files a member's change for the team's admins: one their agent's command asked for (a command may file several),
 * or one they typed in their own workspace terminal.
 */
export async function fileCloudflareChange(
  db: D1Database,
  args: {
    orgId: string;
    connectionId: string;
    userId: string;
    from: { source: 'agent'; agentName: string; toolCallId: string } | { source: 'terminal' };
    request: CloudflareApiRequest;
    requestSha256: string;
    warning: string | null;
    expiresAt: number;
  },
): Promise<{ id: string; expiresAt: number }> {
  const id = crypto.randomUUID();
  const command = args.from.source === 'agent' ? args.from : null;
  await db
    .prepare(
      `INSERT INTO approval_requests (id, org_id, connection_id, requested_by, kind, source, agent_name, tool_call_id,
         request_json, request_sha256, warning, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'cloudflare_change', ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      id,
      args.orgId,
      args.connectionId,
      args.userId,
      args.from.source,
      command?.agentName ?? null,
      command?.toolCallId ?? null,
      JSON.stringify(args.request),
      args.requestSha256,
      args.warning,
      Date.now(),
      args.expiresAt,
    )
    .run();
  return { id, expiresAt: args.expiresAt };
}

/** Requests whose time ran out while waiting are expired, whoever looks first. */
async function expireWaiting(db: D1Database): Promise<void> {
  await db
    .prepare(`UPDATE approval_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`)
    .bind(Date.now())
    .run();
}

/**
 * The requests of every team `userId` is an active admin of: those waiting, then the latest twenty decided.
 */
export async function listApprovals(
  db: D1Database,
  userId: string,
): Promise<{ waiting: ApprovalRequest[]; decided: ApprovalRequest[] }> {
  await expireWaiting(db);
  const { results } = await db
    .prepare(
      `SELECT approval_requests.id, approval_requests.org_id, organizations.name AS org_name, approval_requests.kind,
              approval_requests.source, requester.name AS requester_name, requester.email AS requester_email, approval_requests.request_json,
              approval_requests.warning, approval_requests.status, approval_requests.result,
              approval_requests.outcome_json, decider.name AS decider_name, approval_requests.decided_at,
              approval_requests.created_at, approval_requests.expires_at
       FROM approval_requests
       JOIN organizations ON organizations.id = approval_requests.org_id
       JOIN "user" AS requester ON requester.id = approval_requests.requested_by
       LEFT JOIN "user" AS decider ON decider.id = approval_requests.decided_by
       WHERE ${ACTOR_IS_ADMIN('?1')}
       ORDER BY approval_requests.created_at DESC
       LIMIT 200`,
    )
    .bind(userId)
    .all<ApprovalRow>();
  const requests = results.map(approvalFromRow);
  return {
    waiting: requests.filter((request) => request.status === 'pending').reverse(),
    decided: requests.filter((request) => request.status !== 'pending').slice(0, 20),
  };
}

/**
 * An admin's approval: the request moves to `sending`, once, provided it still waits, `actorId` is one of its
 * team's active admins, and whoever asked is still in the team. Null otherwise.
 */
export async function claimApproval(db: D1Database, id: string, actorId: string): Promise<ClaimedRequest | null> {
  const now = Date.now();
  const row = await db
    .prepare(
      `UPDATE approval_requests SET status = 'sending', decided_by = ?2, decided_at = ?3
       WHERE id = ?1 AND status = 'pending' AND expires_at > ?3 AND ${ACTOR_IS_ADMIN('?2')} AND ${REQUESTER_IS_MEMBER}
       RETURNING id, org_id, connection_id, requested_by, agent_name, request_json`,
    )
    .bind(id, actorId, now)
    .first<{
      id: string;
      org_id: string;
      connection_id: string;
      requested_by: string;
      agent_name: string | null;
      request_json: string;
    }>();
  return row
    ? {
        id: row.id,
        orgId: row.org_id,
        connectionId: row.connection_id,
        requestedBy: row.requested_by,
        agentName: row.agent_name,
        request: cloudflareApiRequestSchema.parse(JSON.parse(row.request_json)),
      }
    : null;
}

/** What came of sending a claimed request. */
export async function finishApproval(
  db: D1Database,
  id: string,
  result: ApprovalResult,
  outcome: CloudflareExecutionSafeOutcome,
): Promise<void> {
  await db
    .prepare(
      `UPDATE approval_requests SET status = 'done', result = ?, outcome_json = ? WHERE id = ? AND status = 'sending'`,
    )
    .bind(result, JSON.stringify(outcome), id)
    .run();
}

/** An admin's rejection: nothing is sent. Answers where the result goes back to, or null when it was not waiting. */
export async function rejectApproval(
  db: D1Database,
  id: string,
  actorId: string,
): Promise<{ requestedBy: string; connectionId: string; agentName: string | null } | null> {
  const now = Date.now();
  const denied: CloudflareExecutionSafeOutcome = { status: 'denied', summary: 'A team admin rejected this change.' };
  const row = await db
    .prepare(
      `UPDATE approval_requests SET status = 'rejected', decided_by = ?2, decided_at = ?3, outcome_json = ?4
       WHERE id = ?1 AND status = 'pending' AND ${ACTOR_IS_ADMIN('?2')}
       RETURNING requested_by, connection_id, agent_name`,
    )
    .bind(id, actorId, now, JSON.stringify(denied))
    .first<{ requested_by: string; connection_id: string; agent_name: string | null }>();
  return row ? { requestedBy: row.requested_by, connectionId: row.connection_id, agentName: row.agent_name } : null;
}

/**
 * A request a member's agent filed, as their workspace reads it back: which command it goes back to, and what
 * became of it. One typed in a terminal goes back to no conversation.
 */
export async function approvalOutcomeFor(
  db: D1Database,
  args: { id: string; userId: string; connectionId: string },
): Promise<{
  agentName: string;
  toolCallId: string;
  requestSha256: string;
  status: ApprovalStatus;
  result: ApprovalResult | null;
  outcome: CloudflareExecutionSafeOutcome | null;
} | null> {
  await expireWaiting(db);
  const row = await db
    .prepare(
      `SELECT agent_name, tool_call_id, request_sha256, status, result, outcome_json FROM approval_requests
       WHERE id = ? AND requested_by = ? AND connection_id = ? AND source = 'agent'`,
    )
    .bind(args.id, args.userId, args.connectionId)
    .first<{
      agent_name: string | null;
      tool_call_id: string | null;
      request_sha256: string;
      status: ApprovalStatus;
      result: ApprovalResult | null;
      outcome_json: string | null;
    }>();
  return row?.agent_name && row.tool_call_id
    ? {
        agentName: row.agent_name,
        toolCallId: row.tool_call_id,
        requestSha256: row.request_sha256,
        status: row.status,
        result: row.result,
        outcome: parseOutcome(row.outcome_json),
      }
    : null;
}

function approvalFromRow(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    kind: row.kind,
    source: row.source,
    requester: { name: row.requester_name, email: row.requester_email },
    request: cloudflareApiRequestSchema.parse(JSON.parse(row.request_json)),
    warning: row.warning,
    status: row.status,
    result: row.result,
    outcome: parseOutcome(row.outcome_json),
    decidedBy: row.decider_name,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function parseOutcome(value: string | null): CloudflareExecutionSafeOutcome | null {
  return value === null ? null : (outcomeSchema.safeParse(JSON.parse(value)).data ?? null);
}
