export function conversationCompactionKey(
  input: Readonly<{
    scope: string;
    throughId: string;
    revision: number;
  }>,
): string {
  return `conversation-compaction:${encodeURIComponent(input.scope)}:${encodeURIComponent(input.throughId)}:${input.revision}`;
}
