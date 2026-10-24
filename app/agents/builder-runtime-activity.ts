import {
  readRuntimeUpgradeWindow,
  recordRuntimeActivity,
  RUNTIME_BUSY_RENEWAL_MS,
} from '~/lib/.server/cloudflare/user-workspace-runtime-activity';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { abortableSleep } from '~/lib/abortable-sleep';
import type { BuilderAgentState } from './builder-agent';

const logger = createScopedLogger('builder-runtime-activity');
const UPGRADE_WINDOW_POLL_MS = 1_000;
/**
 * How long work that can neither record itself busy nor read the upgrade window waits before it starts
 * anyway. Starting unrecorded could let an upgrade cut it off, so it first retries for this long; it
 * never waits forever on a database that stays unavailable.
 */
export const UNRECORDED_ADMISSION_WAIT_MS = 60_000;

/** Why admitted work did not start: an upgrade kept its window open for longer than the work may wait. */
export class RuntimeUpgradeWaitExceededError extends Error {
  constructor() {
    super('The workspace is being upgraded. Send your message again in a minute.');
    this.name = 'RuntimeUpgradeWaitExceededError';
  }
}

/**
 * How admitted work waits out an upgrade window. `signal` calls the wait off (it rejects with the
 * signal's reason); past `maxWaitMs` of an open window it rejects with `RuntimeUpgradeWaitExceededError`;
 * `onWaiting` hears when the work starts and stops being held by an open window.
 */
type RuntimeAdmissionOptions = {
  signal?: AbortSignal;
  maxWaitMs?: number;
  onWaiting?: (waiting: boolean) => void;
};

/**
 * Whether the agent's own turn is running: the turn and the validation it runs. Only the turn sets and
 * clears these. Deployments, approved Cloudflare requests and workspace seeding are counted while
 * their work actually runs (`BuilderRuntimeActivity.run`), not from their records in state, which
 * other paths rewrite while that work continues (an editor save clears the deployment record).
 */
export function isBuilderAgentBusy(state: BuilderAgentState | undefined): boolean {
  return Boolean(state?.activeTurn || state?.validationProgress);
}

type BuilderRuntimeActivityDependencies = {
  db: Pick<D1Database, 'prepare'>;
  agentName: () => string;
};

/**
 * One agent's row in the runtime's activity table, which the control plane reads (through the runtime)
 * before it redeploys the Worker. The agent is busy while its turn runs (from its state) or while any
 * work it began is still running. Writes go one at a time, in order, and only when the agent turns busy
 * or idle, or a busy stretch needs its lease renewed.
 */
export class BuilderRuntimeActivity {
  private writes: Promise<void> = Promise.resolve();
  private recorded: { busy: boolean; at: number } | null = null;
  private turnBusy = false;
  private running = 0;

  constructor(private readonly dependencies: BuilderRuntimeActivityDependencies) {}

  /** Whether the agent's turn is running. A failed write is logged; it never fails the agent's work. */
  observe(turnBusy: boolean): Promise<void> {
    this.turnBusy = turnBusy;
    return this.record().then(() => undefined);
  }

  /**
   * Admit work that keeps the agent busy through its own state, such as a turn: recorded and held back
   * by an upgrade window exactly like `run`, then counted by that state.
   */
  async admit(options: RuntimeAdmissionOptions = {}): Promise<void> {
    (await this.begin(options))();
  }

  /**
   * Run work a redeploy would cut off, counted busy from before it is admitted until it settles. An
   * aborted `signal` calls it off while it still waits for an upgrade window, before `work` starts.
   */
  async run<T>(work: () => Promise<T>, options: RuntimeAdmissionOptions = {}): Promise<T> {
    const end = await this.begin(options);
    try {
      return await work();
    } finally {
      end();
    }
  }

  /**
   * Count work as running and record it busy, then wait out an open upgrade window: that upgrade saw
   * nothing busy and is redeploying the Worker and rolling out its container, so the work starts once
   * the new runtime serves instead of being cut off. Returns the call that ends the work; it is counted
   * until then, whatever the agent's state says meanwhile.
   */
  private async begin(options: RuntimeAdmissionOptions): Promise<() => void> {
    this.running += 1;
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        this.running -= 1;
        void this.record();
      }
    };
    try {
      await this.waitForUpgradeWindow(options);
    } catch (error) {
      end();
      throw error;
    }
    return end;
  }

  /**
   * Fail safe: work starts only once its busy row is written and no window is open. While the database
   * cannot say, it retries, up to `UNRECORDED_ADMISSION_WAIT_MS`.
   */
  private async waitForUpgradeWindow(options: RuntimeAdmissionOptions): Promise<void> {
    const { signal, maxWaitMs, onWaiting } = options;
    const startedAt = Date.now();
    const giveUpAt = startedAt + UNRECORDED_ADMISSION_WAIT_MS;
    let waiting = false;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const recorded = await this.record();
        const now = Date.now();
        const window = recorded
          ? await readRuntimeUpgradeWindow(this.dependencies.db, now).then(
              (open) => ({ open }),
              () => null,
            )
          : null;
        signal?.throwIfAborted();
        if (window && !window.open) {
          return;
        }
        if (window?.open) {
          if (maxWaitMs !== undefined && now - startedAt >= maxWaitMs) {
            throw new RuntimeUpgradeWaitExceededError();
          }
          if (!waiting) {
            waiting = true;
            onWaiting?.(true);
          }
          await abortableSleep(Math.min(UPGRADE_WINDOW_POLL_MS, Math.max(0, window.open.expiresAt - now)), signal);
          continue;
        }
        if (now >= giveUpAt) {
          logger.warn('Starting work the workspace runtime could not record as busy');
          return;
        }
        await abortableSleep(UPGRADE_WINDOW_POLL_MS, signal);
      }
    } finally {
      if (waiting) {
        onWaiting?.(false);
      }
    }
  }

  /** Queue a write of the current busy state; resolves whether it is now recorded. */
  private record(): Promise<boolean> {
    const busy = this.turnBusy || this.running > 0;
    const attempt = this.writes.then(() => this.write(busy));
    this.writes = attempt.catch((error: Error) => {
      logger.warn('Unable to record workspace runtime activity', { message: error.message });
    });
    return attempt.then(
      () => true,
      () => false,
    );
  }

  private async write(busy: boolean): Promise<void> {
    const now = Date.now();
    const recorded = this.recorded;
    if (recorded && recorded.busy === busy && (!busy || now - recorded.at < RUNTIME_BUSY_RENEWAL_MS)) {
      return;
    }
    await recordRuntimeActivity(this.dependencies.db, { agentName: this.dependencies.agentName(), busy, now });
    this.recorded = { busy, at: now };
  }
}
