import { useEffect, useState } from 'react';
import type { LinkedPublishView } from '~/lib/common/linked-publish';

/**
 * A publish's view as of now, shown again when a building view stops being followed: nothing else
 * re-renders the card or the dock then, and a build CloudChef no longer follows must not spin forever.
 */
export function useLinkedPublishView(view: (now: number) => LinkedPublishView | null): LinkedPublishView | null {
  const [now, setNow] = useState(() => Date.now());
  const current = view(now);
  const deadline = current?.followDeadline ?? null;
  useEffect(() => {
    if (deadline === null) {
      return undefined;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()) + 1_000);
    return () => clearTimeout(timer);
  }, [deadline]);
  return current;
}
