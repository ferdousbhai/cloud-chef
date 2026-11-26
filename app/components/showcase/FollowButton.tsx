import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@ui/Button';
import { messageOf } from '~/lib/json-request';
import { setFollowing } from '~/lib/showcase-api';
import { useShowcaseViewer } from './ViewerContext';

/**
 * Follow, or Following: on a person's page and beside their name on a post. The page's viewer says whether they
 * follow this person already (its provider is given the person); nothing shows for the person themselves, or on the
 * post until that is known. A visitor is asked to sign in.
 */
export function FollowButton({
  person,
  size = 'sm',
  onCount,
}: {
  person: { username: string | null; name: string };
  size?: 'xs' | 'sm';
  /** Their followers after a change here. */
  onCount?: (followers: number) => void;
}) {
  const { viewer, signedIn } = useShowcaseViewer();
  // What the viewer said, until a follow here changes it.
  const [following, setFollowingState] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const username = person.username;
  if (!username || (viewer?.signedIn === true && viewer.me.username === username)) {
    return null;
  }
  const isFollowing = following ?? (viewer?.signedIn === true && viewer.following === true);
  const toggle = () =>
    signedIn(`Sign in to follow ${person.name}.`, () => {
      setBusy(true);
      setFollowing(username, !isFollowing)
        .then((answer) => {
          setFollowingState(answer.following);
          onCount?.(answer.followers);
        })
        .catch((error) => toast.error(messageOf(error, 'That didn’t go through. Try again.')))
        .finally(() => setBusy(false));
    });
  return (
    <Button
      size={size}
      variant={isFollowing ? 'neutral' : 'primary'}
      loading={busy}
      onClick={toggle}
      className={size === 'sm' ? 'min-w-24' : 'shrink-0'}
    >
      {isFollowing ? 'Following' : 'Follow'}
    </Button>
  );
}
