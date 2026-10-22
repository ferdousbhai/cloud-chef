/**
 * What the user is told while a preview or a production deployment publishes.
 *
 * Every message here was recorded by the code that did the work: the deployment executor and the
 * workspace runtime write a `deployment_activity` row as they enter each step. Nothing on this path
 * is inferred from a clock. `percent` is the position of that step in the lane's recorded ladder —
 * a real ordering of real steps, not a byte or time fraction — and it is omitted for a step this
 * ladder does not know rather than guessed.
 */

export type BuilderPublicationLane = 'preview' | 'deployment';

export type BuilderPublicationState = {
  lane: BuilderPublicationLane;
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
 * Recorded sequence numbers in the order the lane reaches them. The 31-36 band is the shared
 * artifact preparation inside the workspace runtime, which both lanes run in the middle of their
 * own numbering; a run that reuses the artifact validation already built skips most of it.
 */
const LANE_STAGE_SEQUENCES = {
  preview: [1, 2, 31, 32, 33, 34, 35, 36, 3, 4, 5],
  deployment: [10, 20, 31, 32, 33, 34, 35, 36, 40, 50, 60, 80],
} as const satisfies Record<BuilderPublicationLane, readonly number[]>;

/** The recorded step, and where it sits in its lane's ladder: `Uploading version… 62%`. */
export function publicationStageLabel(state: BuilderPublicationState | null): string | null {
  if (!state) {
    return null;
  }
  return state.percent === null ? `${state.message}…` : `${state.message}… ${state.percent}%`;
}

/** The publication's newest recorded step, and where it sits in the lane's ladder. */
export function publicationProgress(
  lane: BuilderPublicationLane,
  latest: PublicationActivityRow,
): BuilderPublicationState {
  return {
    lane,
    message: latest.message,
    percent: stagePercent(lane, latest.sequence),
    updatedAt: latest.createdAt,
  };
}

function stagePercent(lane: BuilderPublicationLane, sequence: number): number | null {
  const ladder: readonly number[] = LANE_STAGE_SEQUENCES[lane];
  const index = ladder.indexOf(sequence);
  return index < 0 ? null : Math.round(((index + 1) / ladder.length) * 100);
}
