export type ConversationCompactionAction = 'none' | 'background' | 'blocking';

type ConversationCompactionPolicy = Readonly<{
  proactiveTokens: number;
  hardLimitTokens: number;
}>;

export function decideConversationCompaction(
  input: Readonly<{
    estimatedTokens: number;
    pending?: boolean;
    policy: ConversationCompactionPolicy;
  }>,
): ConversationCompactionAction {
  assertPolicy(input.policy);
  const estimated = nonNegativeInteger(input.estimatedTokens, 'estimatedTokens');
  if (estimated >= input.policy.hardLimitTokens) {
    return 'blocking';
  }
  if (estimated >= input.policy.proactiveTokens && !input.pending) {
    return 'background';
  }
  return 'none';
}

export function conversationCompactionKey(
  input: Readonly<{
    scope: string;
    throughId: string;
    revision?: number | string;
  }>,
): string {
  const scope = requiredKeyPart(input.scope, 'scope');
  const throughId = requiredKeyPart(input.throughId, 'throughId');
  const revision = input.revision === undefined ? '0' : requiredKeyPart(String(input.revision), 'revision');
  return `conversation-compaction:${encodeURIComponent(scope)}:${encodeURIComponent(throughId)}:${encodeURIComponent(revision)}`;
}

export function canApplyConversationCompaction(
  input: Readonly<{
    expectedFromId: string;
    expectedThroughId: string;
    currentMessageIds: readonly string[];
    currentThroughId?: string | null;
  }>,
): boolean {
  const start = input.currentMessageIds.indexOf(input.expectedFromId);
  const end = input.currentMessageIds.indexOf(input.expectedThroughId);
  if (start < 0 || end < start) {
    return false;
  }
  if (!input.currentThroughId) {
    return true;
  }
  const currentEnd = input.currentMessageIds.indexOf(input.currentThroughId);
  return currentEnd < end;
}

function assertPolicy(policy: ConversationCompactionPolicy): void {
  const proactive = nonNegativeInteger(policy.proactiveTokens, 'proactiveTokens');
  const hard = nonNegativeInteger(policy.hardLimitTokens, 'hardLimitTokens');
  if (proactive < 1 || hard <= proactive) {
    throw new Error('Compaction policy requires 0 < proactiveTokens < hardLimitTokens');
  }
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requiredKeyPart(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}
