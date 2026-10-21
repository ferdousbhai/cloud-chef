import {
  readRuntimeUpgradeWindow,
  recordRuntimeActivity,
  RUNTIME_BUSY_RENEWAL_MS,
} from '~/lib/.server/cloudflare/user-workspace-runtime-activity';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import type { BuilderAgentState } from './builder-agent';

const logger = createScopedLogger('builder-runtime-activity');
const UPGRADE_WINDOW_POLL_MS = 1_000;
/**
 * How long work that can neither record itself busy nor read the upgrade window waits before it starts
 * anyway. Starting unrecorded could let an upgrade cut it off, so it first retries for this long; it
 * never waits forever on a database that stays unavailable.
 */
export const UNRECORDED_ADMISSION_WAIT_MS = 60_000;

/**
 * Whether the agent's own turn is running: the turn and the validation it runs. Only the turn sets and
 * clears these. Previews, deployments, approved Cloudflare requests and workspace seeding are counted
 * while their work actually runs (`BuilderRuntimeActivity.run`), not from their records in state,
 * which other paths rewrite while that work continues (an editor save clears the deployment record,
 * cancelling a preview marks it cancelled while its build still runs).
 */
export function isBuilderAgentBusy(state: BuilderAgentState | undefined): boolean {
  return Boolean(state?.activeTurn || state?.validationProgress);
}

type BuilderRuntimeActivityDependencies = {
  db: Pick<D1Database, 'prepare'>;
  agentName: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly dependencies: BuilderRuntimeActivityDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Whether the agent's turn is running. A failed write is logged; it never fails the agent's work. */
  observe(turnBusy: boolean): Promise<void> {
    this.turnBusy = turnBusy;
    return this.record().then(() => undefined);
  }

  /**
   * Admit work that keeps the agent busy through its own state, such as a turn: recorded and held back
   * by an upgrade window exactly like `run`, then counted by that state.
   */
  async admit(): Promise<void> {
    (await this.begin())();
  }

  /** Run work a redeploy would cut off, counted busy from before it is admitted until it settles. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    const end = await this.begin();
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
  private async begin(): Promise<() => void> {
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
      await this.waitForUpgradeWindow();
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
  private async waitForUpgradeWindow(): Promise<void> {
    const giveUpAt = this.now() + UNRECORDED_ADMISSION_WAIT_MS;
    for (;;) {
      const recorded = await this.record();
      const now = this.now();
      const window = recorded
        ? await readRuntimeUpgradeWindow(this.dependencies.db, now).then(
            (open) => ({ open }),
            () => null,
          )
        : null;
      if (window && !window.open) {
        return;
      }
      if (window?.open) {
        await this.sleep(Math.min(UPGRADE_WINDOW_POLL_MS, Math.max(0, window.open.expiresAt - now)));
        continue;
      }
      if (now >= giveUpAt) {
        logger.warn('Starting work the workspace runtime could not record as busy');
        return;
      }
      await this.sleep(UPGRADE_WINDOW_POLL_MS);
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
    const now = this.now();
    const recorded = this.recorded;
    if (recorded && recorded.busy === busy && (!busy || now - recorded.at < RUNTIME_BUSY_RENEWAL_MS)) {
      return;
    }
    await recordRuntimeActivity(this.dependencies.db, { agentName: this.dependencies.agentName(), busy, now });
    this.recorded = { busy, at: now };
  }
}
