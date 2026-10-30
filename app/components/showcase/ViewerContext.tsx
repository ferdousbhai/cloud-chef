import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { setLiked, useViewer, type Viewer } from '~/lib/showcase-api';
import { messageOf } from '~/lib/json-request';
import { SignInOverlay } from './SignInOverlay';

/**
 * The person looking at a public showcase page, shared by everything on it: whether they're signed in, what they
 * liked, which posts they manage, and a way to ask them to sign in first. Until it loads, the page shows as a visitor
 * sees it.
 */
type ShowcaseViewer = {
  viewer: Viewer | null;
  refresh: () => void;
  liked: (postId: string) => boolean;
  likeCount: (postId: string, initial: number) => number;
  toggleLike: (postId: string, initial: number) => void;
  manages: (postId: string) => boolean;
  /** Runs `action` for someone signed in; asks anyone else to sign in, returning to `returnTo`. */
  signedIn: (title: string, action: () => void, returnTo?: string) => void;
};

const Context = createContext<ShowcaseViewer | null>(null);

export function ShowcaseViewerProvider({
  postIds,
  person,
  children,
}: {
  postIds: readonly string[];
  person?: string;
  children: ReactNode;
}) {
  const { viewer, refresh } = useViewer(postIds, person);
  // Likes changed here, over what the viewer said was liked; counts start from the page's own until then.
  const [likes, setLikes] = useState(new Map<string, { liked: boolean; count: number }>());
  const [signIn, setSignIn] = useState<{ title: string; returnTo: string } | null>(null);

  const signedIn = useCallback(
    (title: string, action: () => void, returnTo?: string) => {
      if (viewer?.signedIn) {
        action();
        return;
      }
      setSignIn({ title, returnTo: returnTo ?? `${window.location.pathname}${window.location.search}` });
    },
    [viewer],
  );

  const value = useMemo<ShowcaseViewer>(() => {
    const likedBefore = (postId: string) => (viewer?.signedIn ? viewer.liked.includes(postId) : false);
    return {
      viewer,
      refresh,
      liked: (postId) => likes.get(postId)?.liked ?? likedBefore(postId),
      likeCount: (postId, initial) => likes.get(postId)?.count ?? initial,
      toggleLike: (postId, initial) =>
        signedIn('Sign in to like this.', () => {
          const current = likes.get(postId);
          const wasLiked = current?.liked ?? likedBefore(postId);
          const count = current?.count ?? initial;
          const optimistic = { liked: !wasLiked, count: Math.max(0, count + (wasLiked ? -1 : 1)) };
          setLikes((map) => new Map(map).set(postId, optimistic));
          setLiked(postId, !wasLiked)
            .then((answer) =>
              setLikes((map) => new Map(map).set(postId, { liked: answer.liked, count: answer.likeCount })),
            )
            .catch((error) => {
              setLikes((map) => new Map(map).set(postId, { liked: wasLiked, count }));
              toast.error(messageOf(error, 'That didn’t go through. Try again.'));
            });
        }),
      manages: (postId) => (viewer?.signedIn ? viewer.managed.includes(postId) : false),
      signedIn,
    };
  }, [viewer, refresh, likes, signedIn]);

  return (
    <Context.Provider value={value}>
      {children}
      {signIn ? (
        <SignInOverlay title={signIn.title} returnTo={signIn.returnTo} onClose={() => setSignIn(null)} />
      ) : null}
    </Context.Provider>
  );
}

export function useShowcaseViewer(): ShowcaseViewer {
  const value = useContext(Context);
  if (!value) {
    throw new Error('useShowcaseViewer is used outside ShowcaseViewerProvider.');
  }
  return value;
}
