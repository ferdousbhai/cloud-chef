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

/**
 * How long one tool call may run before it is stopped as hung. A stopped call is an ordinary
 * failed tool result: the model sees it and decides what to do next, and the turn goes on.
 */
export const BUILDER_TOOL_DEADLINES_MS = {
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
  // Reads are one bounded API request; writes only persist an approval proposal. An approved
  // write runs later in its own durable fiber under the client's own deadline.
  cloudflare_request: 90_000,
  // A commit, under its own two-minute request deadline; the pipeline's build is watched in the background.
  publish_preview: 4 * 60_000,
  publish: 4 * 60_000,
  // A control-plane lookup of the site's addresses, then one bounded GET (with a few redirects).
  fetch_site: 60_000,
} as const satisfies Record<ModelToolName, number>;

export class BuilderToolDeadlineError extends Error {
  constructor(toolName: ModelToolName) {
    const minutes = Math.max(1, Math.round(BUILDER_TOOL_DEADLINES_MS[toolName] / 60_000));
    super(`${toolName} did not finish within ${minutes} minute${minutes === 1 ? '' : 's'} and was stopped.`);
    this.name = 'BuilderToolDeadlineError';
  }
}

/**
 * How long a stopped tool has to settle before its call ends without it. Cancelling a container
 * command confirms within about half a minute; a tool that ignores its signal would otherwise hold
 * the turn, whose inactivity watchdog is paused while a tool runs.
 */
export const BUILDER_TOOL_STOP_GRACE_MS = 60_000;

/** A tool that was stopped and did not settle in time: what it did is unknown, not undone. */
export class BuilderToolUnsettledError extends Error {
  constructor(toolName: ModelToolName) {
    super(
      `${toolName} was stopped but did not finish stopping within ${BUILDER_TOOL_STOP_GRACE_MS / 1_000} seconds, so whether it changed the project is unknown. Check the workspace before repeating it.`,
    );
    this.name = 'BuilderToolUnsettledError';
  }
}

/** The turn-level guards against a hung provider stream or workspace. None of them limits the model's work. */
export type BuilderTurnLimitReason = 'wall_clock' | 'inactivity' | 'no_first_progress';

export type BuilderTurnTerminalReason = BuilderTurnLimitReason | 'completed' | 'cancelled' | 'failed';

/** Content-free turn accounting. Never carries prompt or generated code. */
export type BuilderTurnReport = {
  terminalReason: BuilderTurnTerminalReason;
  stepCount: number;
  toolCallCount: number;
  elapsedMs: number;
  /**
   * Wall-clock time with at least one tool in flight — a union of the tool intervals, not their
   * sum, because the Pi loop runs a batch concurrently. `elapsedMs - toolWallClockMs` is therefore
   * the time the turn spent waiting on the model.
   */
  toolWallClockMs: number;
  /** Per-tool totals. Summed, so a concurrent batch can exceed `toolWallClockMs`. */
  toolMsByName: Record<string, number>;
  /** Whether the turn ran a tool that can change the project (write, edit, or exec). */
  changedProject: boolean;
};

export class BuilderTurnLimitError extends Error {
  constructor(readonly reason: BuilderTurnLimitReason) {
    super(
      reason === 'no_first_progress'
        ? 'The model did not start responding within a minute. Retry, or pick a different model.'
        : reason === 'inactivity'
          ? 'The model stream stopped responding. Send a follow-up to continue.'
          : 'This turn ran for its maximum time. Send a follow-up to continue.',
    );
    this.name = 'BuilderTurnLimitError';
  }
}
