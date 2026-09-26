import type { ExecutionObservation } from './execution-reattach';
import type { WorkspaceOperationHolder, WorkspaceOperationLane } from './workspace-operation-lane';

/** How long a "not finished" answer stands before the container is asked again. */
const UNSETTLED_RECHECK_MS = 10_000;

/**
 * An exec lane whose owner died with a previous instance stays leased because its command may still
 * be running in the container, which outlives the reset (#143). When the container shows that the
 * command has finished, the lease protects nothing, so the holder is named as reclaimable. A running
 * or unobservable command keeps the lease until its deadline, exactly as before, and that answer is
 * remembered briefly so every operation retrying through the conflict does not probe again.
 */
export class InterruptedExecSettlement {
  #unsettled: { owner: string; idempotencyKey: string; checkedAt: number } | null = null;

  constructor(private readonly observe: (executionId: string) => Promise<ExecutionObservation>) {}

  /**
   * Only an interrupted exec holder is probed, and only for a different key: the same key must
   * resume its own command, never be handed a lane that would replay it.
   */
  async findSettledHolder(args: {
    holder: ReturnType<WorkspaceOperationLane['interruptedHolder']>;
    idempotencyKey: string;
    now: number;
  }): Promise<WorkspaceOperationHolder | undefined> {
    const { holder, now } = args;
    if (!holder || holder.kind !== 'exec' || holder.idempotencyKey === args.idempotencyKey) {
      return undefined;
    }
    const unsettled = this.#unsettled;
    if (
      unsettled?.owner === holder.owner &&
      unsettled.idempotencyKey === holder.idempotencyKey &&
      now - unsettled.checkedAt < UNSETTLED_RECHECK_MS
    ) {
      return undefined;
    }
    // The exec lane's key is the id its command runs under in the container.
    const observation = await this.observe(holder.idempotencyKey).catch((): ExecutionObservation => 'unobservable');
    if (observation !== 'finished') {
      this.#unsettled = { owner: holder.owner, idempotencyKey: holder.idempotencyKey, checkedAt: now };
      return undefined;
    }
    this.#unsettled = null;
    return { owner: holder.owner, idempotencyKey: holder.idempotencyKey };
  }
}
