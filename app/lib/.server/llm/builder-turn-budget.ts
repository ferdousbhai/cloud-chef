import type { ModelToolName } from 'cloudchef-agent/model-tool-inputs';

export const BUILDER_MUTATION_TOOL_TIMEOUT_MS = 35 * 60_000;

/**
 * Hard deadline for the whole turn, and a guard rather than a budget: it
 * surfaces a visible, resumable error instead of silently shortening the work.
 * It has to clear several back-to-back mutation tool deadlines plus the model
 * time around them, so a high-effort model building a real application is never
 * cut off mid-build. Only a genuinely wedged turn should ever reach it — the
 * inactivity watchdog catches a dead stream long before this.
 */
export const BUILDER_TURN_WALL_CLOCK_MS = 4 * 60 * 60_000;

/**
 * No model or tool event at all for this long means the turn is wedged. Tools
 * carry their own deadlines, so this watchdog only covers the gaps between them.
 */
export const BUILDER_TURN_INACTIVITY_MS = 5 * 60_000;

/**
 * A model that has produced no visible text, tool call, or tool execution this
 * soon after the request started is stalled, not thinking: the benchmark model
 * burned eight silent minutes before ending with nothing. Transport noise does
 * not count as progress; the first meaningful event disarms this deadline for
 * the rest of the turn.
 */
export const BUILDER_TURN_FIRST_PROGRESS_MS = 60_000;

/** Product deadlines enforced cooperatively by the shared Pi tool adapter. */
export const BUILDER_TURN_TIMEOUTS = {
  tools: {
    read: 2 * 60_000,
    // Discovery never leaves the Durable Object, so a minute of it is already a wedged workspace
    // rather than slow work; it must not inherit a container-sized deadline.
    ls: 60_000,
    grep: 60_000,
    write: BUILDER_MUTATION_TOOL_TIMEOUT_MS,
    edit: BUILDER_MUTATION_TOOL_TIMEOUT_MS,
    exec: BUILDER_MUTATION_TOOL_TIMEOUT_MS,
    validate: BUILDER_MUTATION_TOOL_TIMEOUT_MS,
    search_cloudflare_docs: 60_000,
    cloudflare_docs: 90_000,
    cloudflare_search: 90_000,
    // Initial calls only persist an approval proposal. Approved execution runs later in its own
    // durable fiber under the gateway's independent overall deadline.
    cloudflare_execute: 30_000,
  } satisfies Record<ModelToolName, number>,
} as const;

export const BUILDER_TURN_BUDGET_ERROR_CODE = 'builder_turn_budget_exhausted';

export type BuilderTurnBudgetReason = 'tool_timeout' | 'wall_clock' | 'inactivity' | 'no_first_progress';

export type BuilderTurnTerminalReason = BuilderTurnBudgetReason | 'completed' | 'cancelled' | 'failed';

/** Content-free turn accounting. Never carries prompt or generated code. */
export type BuilderTurnBudgetReport = {
  terminalReason: BuilderTurnTerminalReason;
  stepCount: number;
  toolCallCount: number;
  elapsedMs: number;
  /**
   * Wall-clock time with at least one tool in flight — a union of the tool intervals, not their
   * sum, because the Pi loop runs a batch concurrently. `elapsedMs - toolWallClockMs` is therefore
   * the time the turn spent waiting on the model.
   *
   * This split is the one number that says whether a slow turn was slow because of inference or
   * because of the workspace, and without it every latency question about a build is a guess.
   */
  toolWallClockMs: number;
  /** Per-tool totals. Summed, so a concurrent batch can exceed `toolWallClockMs`. */
  toolMsByName: Record<string, number>;
  lastValidationState: 'validated' | 'unvalidated';
};

export class BuilderTurnBudgetExceededError extends Error {
  readonly code = BUILDER_TURN_BUDGET_ERROR_CODE;

  constructor(readonly reason: BuilderTurnBudgetReason) {
    super(
      JSON.stringify({
        code: BUILDER_TURN_BUDGET_ERROR_CODE,
        error:
          reason === 'no_first_progress'
            ? 'The model did not start responding within a minute. Retry, or pick a different model.'
            : 'This build reached its safe execution limit before it finished. Send a follow-up to continue.',
        reason,
        retryable: true,
      }),
    );
    this.name = 'BuilderTurnBudgetExceededError';
  }
}
