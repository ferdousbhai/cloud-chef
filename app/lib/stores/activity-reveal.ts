import { atom } from 'nanostores';

/**
 * Counts requests to bring the current run's process into view. The status line under the
 * conversation raises it; the Activity panel answers only requests made while it is mounted.
 */
export const activityRevealStore = atom(0);

export function revealActivity(): void {
  activityRevealStore.set(activityRevealStore.get() + 1);
}
