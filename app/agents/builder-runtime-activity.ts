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
 * Whether the agent is doing something a redeploy of its Worker would cut off: a turn (and the
 * validation and GitHub publishing it runs), a preview or production publication, or an approved
 * Cloudflare request.
 */
export function isBuilderAgentBusy(state: BuilderAgentState | undefined): boolean {
  if (!state) {
    return false;
  }
  return Boolean(
    state.activeTurn ||
    state.validationProgress ||
    state.publication ||
    state.preview?.status === 'queued' ||
    state.preview?.status === 'building' ||
    state.deployment?.status === 'deploying' ||
    state.cloudflareExecutions?.some(
      (execution) => execution.status === 'approved' || execution.status === 'executing',
    ),
  );
}

type BuilderRuntimeActivityDependencies = {
  db: Pick<D1Database, 'prepare'>;
  agentName: () => string;
  /** The Worker version this agent runs, which an upgrade window names when it is the one arriving. */
  runtimeVersion: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * One agent's row in the runtime's activity table, which the control plane reads (through the runtime)
 * before it redeploys the Worker. Writes go one at a time, in order, and only when the agent turns busy
 * or idle, or a busy stretch needs its lease renewed.
 */
export class BuilderRuntimeActivity {
  private writes: Promise<void> = Promise.resolve();
  private recorded: { busy: boolean; at: number } | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly dependencies: BuilderRuntimeActivityDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Record that the agent is busy or idle. A failed write is logged; it never fails the agent's work. */
  observe(busy: boolean): Promise<void> {
    this.writes = this.writes
      .then(() => this.write(busy))
      .catch((error: Error) => {
        logger.warn('Unable to record workspace runtime activity', { message: error.message });
      });
    return this.writes;
  }

  /**
   * Record work as it starts, then wait out an upgrade window claimed for another Worker version: that
   * upgrade saw nothing busy, so it is about to redeploy, and this work starts on the new version
   * instead of being cut off on the old one. The window is short and bounds the wait.
   */
  async admit(): Promise<void> {
    await this.observe(true);
    for (;;) {
      const now = this.now();
      const window = await readRuntimeUpgradeWindow(this.dependencies.db, now).catch(() => null);
      if (!window || window.targetVersion === this.dependencies.runtimeVersion) {
        return;
      }
      await this.sleep(Math.min(UPGRADE_WINDOW_POLL_MS, Math.max(0, window.expiresAt - now)));
    }
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
