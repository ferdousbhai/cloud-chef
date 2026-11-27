/** How one publish of a commit of main went: still running, done, failed, or nothing built. */
export type PublishOutcome = 'running' | 'succeeded' | 'failed' | 'none';

/** Whether a commit of main is live now, was live before a newer one, is on its way, or didn't go live. */
export type PublishState = 'live' | 'published' | 'publishing' | 'failed';

/**
 * Each commit's publish state from its publishes, newest first: the newest that succeeded is live, older ones that
 * succeeded were published, and a commit's newest publish decides the rest. A commit nothing built is left out.
 */
export function foldPublishes(
  publishes: readonly { commit: string; outcome: PublishOutcome }[],
): Map<string, PublishState> {
  const states = new Map<string, PublishState>();
  let liveFound = false;
  for (const { commit, outcome } of publishes) {
    if (states.has(commit) || outcome === 'none') {
      continue;
    }
    if (outcome === 'succeeded') {
      states.set(commit, liveFound ? 'published' : 'live');
      liveFound = true;
    } else {
      states.set(commit, outcome === 'running' ? 'publishing' : 'failed');
    }
  }
  return states;
}
