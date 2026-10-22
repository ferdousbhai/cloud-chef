import type { WorkspaceOperationLane, WorkspaceOperationLease } from './workspace-operation-lane';

/** Renew three times per lease so a single missed tick cannot drop the lane. */
const HEARTBEAT_TICKS_PER_LEASE = 3;

/** How an operation reports that it is still doing the work it leased the lane for. */
export type OperationLiveness = {
  /** Observable progress: a streamed chunk, an exit event, a finished step. */
  observed(): void;
};

type OperationLeaseHeartbeatOptions = {
  lane: Pick<WorkspaceOperationLane, 'renew'>;
  lease: WorkspaceOperationLease;
  leaseMs: number;
  /** Absolute time until which silence alone still counts as being alive. */
  silenceHorizon: number;
};

/**
 * Keep a lane leased for as long as its owner is demonstrably alive.
 *
 * Two independent proofs count, and either one is enough. Observed progress
 * shows the command is running. So does being inside the silence horizon: a
 * quiet typecheck is the normal case, not a dead one, and the tool budget above
 * the lane is what bounds how long quiet is allowed to last. A command that has
 * gone quiet *and* outlived that budget has neither proof, so renewal stops and
 * the lane ages out on its own for another request to reclaim.
 *
 * An owner that actually died stops ticking altogether, which is what makes the
 * lease reclaimable in the case it exists for.
 */
export class OperationLeaseHeartbeat implements OperationLiveness {
  readonly #options: OperationLeaseHeartbeatOptions;
  #lease: WorkspaceOperationLease;
  #lastProgressAt: number | null = null;
  #lost: Error | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: OperationLeaseHeartbeatOptions) {
    this.#options = options;
    this.#lease = options.lease;
    this.#schedule();
  }

  observed(): void {
    this.#lastProgressAt = Date.now();
  }

  /** Fail closed if the lane stopped being this operation's to hold. */
  requireHeld(): void {
    if (this.#lost) {
      throw this.#lost;
    }
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    this.#timer = setTimeout(
      () => this.#tick(),
      Math.max(1, Math.floor(this.#options.leaseMs / HEARTBEAT_TICKS_PER_LEASE)),
    );
  }

  #tick(): void {
    const now = Date.now();
    const progressing = this.#lastProgressAt !== null && now - this.#lastProgressAt < this.#options.leaseMs;
    if (!progressing && now >= this.#options.silenceHorizon) {
      // Nothing here proves the work is still happening, so let the lane age out.
      return;
    }
    try {
      this.#lease = this.#options.lane.renew(this.#lease, this.#options.leaseMs);
    } catch (error) {
      this.#lost = error instanceof Error ? error : new Error(String(error));
      return;
    }
    this.#schedule();
  }
}
