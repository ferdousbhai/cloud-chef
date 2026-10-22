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

function requiredKeyPart(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}
