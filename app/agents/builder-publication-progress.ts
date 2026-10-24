/**
 * What the user is told while a production deployment publishes.
 *
 * Every message here was recorded by the code that did the work: the deployment executor and the
 * workspace runtime write a `deployment_activity` row as they enter each step. Nothing on this path
 * is inferred from a clock. `percent` is the position of that step in the recorded ladder —
 * a real ordering of real steps, not a byte or time fraction — and it is omitted for a step this
 * ladder does not know rather than guessed.
 */

export type BuilderPublicationState = {
  message: string;
  percent: number | null;
  updatedAt: number;
};

type PublicationActivityRow = {
  sequence: number;
  message: string;
  createdAt: number;
};

/**
 * Recorded sequence numbers in the order a deployment reaches them. The 31-36 band is the artifact
 * preparation inside the workspace runtime, which runs in the middle of the executor's own numbering;
 * a run that reuses the artifact validation already built skips most of it.
 */
const STAGE_SEQUENCES: readonly number[] = [10, 20, 31, 32, 33, 34, 35, 36, 40, 50, 60, 80];

/** The recorded step, and where it sits in the ladder: `Uploading version… 62%`. */
export function publicationStageLabel(state: BuilderPublicationState | null): string | null {
  if (!state) {
    return null;
  }
  return state.percent === null ? `${state.message}…` : `${state.message}… ${state.percent}%`;
}

/** The publication's newest recorded step, and where it sits in the ladder. */
export function publicationProgress(latest: PublicationActivityRow): BuilderPublicationState {
  return {
    message: latest.message,
    percent: stagePercent(latest.sequence),
    updatedAt: latest.createdAt,
  };
}

function stagePercent(sequence: number): number | null {
  const index = STAGE_SEQUENCES.indexOf(sequence);
  return index < 0 ? null : Math.round(((index + 1) / STAGE_SEQUENCES.length) * 100);
}
