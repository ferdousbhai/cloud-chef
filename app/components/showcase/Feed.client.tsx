import { useEffect, useState } from 'react';
import { Button } from '@ui/Button';
import { LinkButton } from '~/components/ui/LinkButton';
import { messageOf } from '~/lib/json-request';
import { loadFeedPage } from '~/lib/showcase-api';
import type { PostView, ShowcaseCursor } from '~/lib/showcase';
import { PostCard } from './PostCard';
import { ShowcaseViewerProvider } from './ViewerContext';

/** `/feed`: posts from the people the signed-in person follows, newest first, one under another. */
export function Feed() {
  const [posts, setPosts] = useState<PostView[] | null>(null);
  const [next, setNext] = useState<ShowcaseCursor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    loadFeedPage(null, controller.signal)
      .then((page) => {
        setPosts(page.posts);
        setNext(page.next);
      })
      .catch((cause) => !controller.signal.aborted && setError(messageOf(cause, 'Your feed couldn’t be loaded.')));
    return () => controller.abort();
  }, [attempt]);

  const more = () => {
    setLoadingMore(true);
    loadFeedPage(next)
      .then((page) => {
        setPosts((current) => [...(current ?? []), ...page.posts]);
        setNext(page.next);
      })
      .catch(() => setError('More posts couldn’t be loaded.'))
      .finally(() => setLoadingMore(false));
  };

  return (
    <main className="mx-auto grid w-full max-w-[520px] gap-5 px-0 pb-16 pt-4 sm:px-4 sm:pt-8">
      <h1 className="sr-only">Feed</h1>
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-center gap-2 px-4 text-sm text-content-secondary"
        >
          <span>{error}</span>
          <Button
            size="xs"
            variant="neutral"
            onClick={() => {
              setError(null);
              setAttempt((count) => count + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {posts === null && !error ? (
        <p className="py-16 text-center text-sm text-content-tertiary" role="status">
          Loading your feed…
        </p>
      ) : null}
      {posts?.length === 0 ? (
        <div className="grid justify-items-center gap-3 px-6 py-20 text-center">
          <p className="text-lg font-semibold text-content-primary">Your feed is empty</p>
          <p className="max-w-sm text-sm text-content-secondary">
            Follow people whose work you like, and what they make shows up here.
          </p>
          <LinkButton to="/explore">Explore what people made</LinkButton>
        </div>
      ) : null}
      {posts && posts.length > 0 ? (
        <ShowcaseViewerProvider postIds={posts.map((post) => post.id)}>
          <div className="grid gap-5">
            {posts.map((post, index) => (
              <PostCard key={post.id} post={post} priority={index < 2} />
            ))}
          </div>
        </ShowcaseViewerProvider>
      ) : null}
      {next ? (
        <div className="flex justify-center">
          <Button variant="neutral" loading={loadingMore} onClick={more}>
            More
          </Button>
        </div>
      ) : null}
    </main>
  );
}
