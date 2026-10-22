/**
 * Wall-clock accounting for the tool half of a turn.
 *
 * The union rather than the sum, because the Pi loop executes one assistant message's tool calls
 * concurrently: three parallel reads that each take a second cost the turn one second, not three.
 * Subtracting the union from the turn's elapsed time is what makes "was this turn slow because of
 * the model or because of the workspace" answerable from telemetry instead of by guessing.
 */
export function createToolTimeAccounting() {
  const open = new Map<string, { toolName: string; startedAt: number }>();
  const byName: Record<string, number> = {};
  let unionStartedAt: number | null = null;
  let unionMs = 0;

  const closeUnion = (at: number) => {
    if (unionStartedAt !== null) {
      unionMs += Math.max(0, at - unionStartedAt);
      unionStartedAt = null;
    }
  };

  return {
    start(toolCallId: string, toolName: string): void {
      const at = Date.now();
      if (open.size === 0) {
        unionStartedAt = at;
      }
      open.set(toolCallId, { toolName, startedAt: at });
    },
    end(toolCallId: string): void {
      const entry = open.get(toolCallId);
      if (!entry) {
        return;
      }
      const at = Date.now();
      open.delete(toolCallId);
      byName[entry.toolName] = (byName[entry.toolName] ?? 0) + Math.max(0, at - entry.startedAt);
      if (open.size === 0) {
        closeUnion(at);
      }
    },
    /** A turn can end with tools still open — cancellation, an aborted stream. Bank what ran. */
    settle(): void {
      const at = Date.now();
      for (const entry of open.values()) {
        byName[entry.toolName] = (byName[entry.toolName] ?? 0) + Math.max(0, at - entry.startedAt);
      }
      open.clear();
      closeUnion(at);
    },
    wallClockMs: () => unionMs,
    byName: () => ({ ...byName }),
  };
}
