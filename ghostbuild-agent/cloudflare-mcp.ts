export const CLOUDFLARE_EXECUTION_APPROVAL_TTL_MS = 15 * 60_000;

export const CLOUDFLARE_EXECUTION_STATUSES = [
  'awaiting_approval',
  'approved',
  'rejected',
  'executing',
  'succeeded',
  'failed',
  'indeterminate',
  'expired',
] as const;

export type CloudflareExecutionStatus = (typeof CLOUDFLARE_EXECUTION_STATUSES)[number];

export type CloudflareExecutionSafeOutcome = {
  status: 'success' | 'failure' | 'insufficient_scope' | 'indeterminate' | 'denied';
  summary: string;
  content?: string;
  requestId?: string | null;
  httpStatus?: number | null;
  truncated?: boolean;
  sensitiveContentWithheld?: boolean;
};

/** Browser-safe projection of a durable approval record. It never contains credentials or raw responses. */
export type CloudflareExecutionPublicState = {
  executionId: string;
  toolCallId: string;
  accountId: string;
  proposalSha256: string;
  status: CloudflareExecutionStatus;
  createdAt: number;
  decidedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  expiresAt: number;
  outcome: CloudflareExecutionSafeOutcome | null;
};

export type CloudflareExecutionDecisionResult = {
  execution: CloudflareExecutionPublicState;
  resumeTurn: boolean;
};

export type CloudflareExecutionDecisionHandler = (
  executionId: string,
  decision: 'approve' | 'reject',
) => Promise<CloudflareExecutionDecisionResult>;

export type CloudflareExecuteProposal = {
  kind: 'cloudflare_execute_proposal';
  status: 'awaiting_approval';
  executionId: string;
  toolCallId: string;
  accountId: string;
  code: string;
  proposalSha256: string;
  riskNote: string;
  expiresAt: number;
};

export type CloudflareMcpImmediateResult = {
  kind: 'cloudflare_mcp_result';
  operation: 'docs' | 'search';
  status: 'success' | 'failure' | 'insufficient_scope';
  accountId: string;
  content?: string;
  requestId: string | null;
  httpStatus: number | null;
  truncated: boolean;
};

export type CloudflareExecuteFinalResult = {
  kind: 'cloudflare_execute_result';
  executionId: string;
  accountId: string;
  proposalSha256: string;
  status: Exclude<CloudflareExecutionStatus, 'awaiting_approval' | 'approved' | 'executing'>;
  outcome: CloudflareExecutionSafeOutcome;
};

type CloudflareExecuteProposalCandidate = Pick<CloudflareExecuteProposal, 'kind'>;
export type CloudflareMcpResultCandidate = { kind: string; status?: string };

export function isCloudflareExecuteProposal(
  value: CloudflareMcpResultCandidate | null,
): value is CloudflareExecuteProposalCandidate {
  return value !== null && 'kind' in value && value.kind === 'cloudflare_execute_proposal';
}
