import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@ui/Button';
import { loadExplorePage } from '~/lib/showcase-api';
import type { PostView, ShowcaseCursor } from '~/lib/showcase';
import { PostGrid } from './PostGrid';
import { ShowcaseViewerProvider, useShowcaseViewer } from './ViewerContext';

type Page = { posts: PostView[]; next: ShowcaseCursor | null };

/**
 * `/explore`: everyone's posts, newest first, for anyone, signed in or not. Someone who follows people can narrow it
 * to what those people made.
 */
export function ExplorePage({ posts, next }: Page) {
  return (
    <ShowcaseViewerProvider postIds={[]}>
      <ExplorePageContent posts={posts} next={next} />
    </ShowcaseViewerProvider>
  );
}

function ExplorePageContent(first: Page) {
  const { viewer } = useShowcaseViewer();
  const [everyone, setEveryone] = useState<Page>(first);
  // What the people they follow made: asked for the first time "Following" is chosen.
  const [followed, setFollowed] = useState<Page | null>(null);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(false);
  const followsAnyone = viewer?.signedIn === true && viewer.followsAnyone;
  const page = following ? followed : everyone;

  const choose = (onlyFollowed: boolean) => {
    setFollowing(onlyFollowed);
    if (onlyFollowed && !followed) {
      loadExplorePage(null, true)
        .then(setFollowed)
        .catch(() => {
          setFollowing(false);
          toast.error('That couldn’t be loaded. Try again.');
        });
    }
  };
  const more = () => {
    if (!page) {
      return;
    }
    const add = (current: Page | null, loaded: Page) => ({
      posts: [...(current?.posts ?? []), ...loaded.posts],
      next: loaded.next,
    });
    setLoading(true);
    loadExplorePage(page.next, following)
      .then((loaded) =>
        following ? setFollowed((current) => add(current, loaded)) : setEveryone((current) => add(current, loaded)),
      )
      .catch(() => toast.error('More posts couldn’t be loaded. Try again.'))
      .finally(() => setLoading(false));
  };

  return (
    <main className="mx-auto grid w-full max-w-5xl gap-5 px-3 pb-16 pt-6 sm:px-6 sm:pt-10">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 px-1">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-content-primary">Explore</h1>
          <p className="text-sm text-content-secondary">
            What people made with CloudChef. Open one to try it, or make it your own.
          </p>
        </div>
        {followsAnyone ? (
          <div role="group" aria-label="Whose posts" className="flex gap-1">
            <Button
              size="xs"
              variant={following ? 'subtle' : 'neutral'}
              aria-pressed={!following}
              onClick={() => choose(false)}
            >
              Everyone
            </Button>
            <Button
              size="xs"
              variant={following ? 'neutral' : 'subtle'}
              aria-pressed={following}
              onClick={() => choose(true)}
            >
              Following
            </Button>
          </div>
        ) : null}
      </div>
      {page === null ? (
        <p className="py-16 text-center text-sm text-content-tertiary" role="status">
          Loading…
        </p>
      ) : page.posts.length === 0 ? (
        <p className="py-16 text-center text-sm text-content-secondary">
          {following
            ? 'The people you follow haven’t posted anything yet.'
            : 'Nothing here yet. Make a project public and publish it to be the first.'}
        </p>
      ) : (
        <PostGrid posts={page.posts} showAuthor />
      )}
      {page?.next ? (
        <div className="flex justify-center">
          <Button variant="neutral" loading={loading} onClick={more}>
            More
          </Button>
        </div>
      ) : null}
    </main>
  );
}
