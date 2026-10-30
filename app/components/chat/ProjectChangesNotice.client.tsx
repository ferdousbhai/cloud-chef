import { useStore } from '@nanostores/react';
import { useState } from 'react';
import { formatDistanceStrict } from 'date-fns';
import { projectChangesNoticeStore, type ChangedSince } from '~/lib/cloudflare/project-presence.client';
import { projectDialogStore } from '~/lib/stores/project-actions.client';
import { Notice } from './NewModelsNotice.client';

/**
 * Opening a project others published changes to since this person was last here says so once, above the prompt box,
 * with the way to see them; closing it, or going to see them, puts it away.
 */
export function ProjectChangesNotice() {
  const changed = useStore(projectChangesNoticeStore);
  // Said as of when the tip first showed; it doesn't count on while it stays.
  const [shownAt] = useState(() => Date.now());
  if (!changed) {
    return null;
  }
  const dismiss = () => projectChangesNoticeStore.set(null);
  return (
    <Notice placement="above" onDismiss={dismiss}>
      {changesSentence(changed, shownAt)}{' '}
      <button
        type="button"
        className="font-semibold text-content-primary underline underline-offset-2 hover:no-underline"
        onClick={() => {
          dismiss();
          projectDialogStore.set('history');
        }}
      >
        See what changed
      </button>
    </Notice>
  );
}

/** "Sara published a change 10 minutes ago, since you were last here.", and with more changes or people. */
export function changesSentence(changed: ChangedSince, now: number): string {
  const [first, second] = changed.people;
  const who =
    changed.people.length === 0
      ? 'Someone'
      : changed.people.length === 1
        ? first
        : changed.people.length === 2
          ? `${first} and ${second}`
          : `${first}, ${second} and others`;
  const ago = formatDistanceStrict(Math.min(changed.latestAt, now), now, { addSuffix: true });
  return changed.count === 1
    ? `${who} published a change ${ago}, since you were last here.`
    : `${who} published ${changed.count} changes since you were last here, the latest ${ago}.`;
}
