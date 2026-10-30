import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@ui/Button';
import { loadExplorePage } from '~/lib/showcase-api';
import type { PostView, ShowcaseCursor } from '~/lib/showcase';
import { PostGrid } from './PostGrid';

/** `/explore`: everyone's posts, newest first, for anyone, signed in or not. */
export function ExplorePage({
  posts: firstPosts,
  next: firstNext,
}: {
  posts: PostView[];
  next: ShowcaseCursor | null;
}) {
  const [posts, setPosts] = useState(firstPosts);
  const [next, setNext] = useState(firstNext);
  const [loading, setLoading] = useState(false);
  const more = () => {
    setLoading(true);
    loadExplorePage(next)
      .then((page) => {
        setPosts((current) => [...current, ...page.posts]);
        setNext(page.next);
      })
      .catch(() => toast.error('More posts couldn’t be loaded. Try again.'))
      .finally(() => setLoading(false));
  };
  return (
    <main className="mx-auto grid w-full max-w-5xl gap-5 px-3 pb-16 pt-6 sm:px-6 sm:pt-10">
      <div className="grid gap-1 px-1">
        <h1 className="text-2xl font-semibold tracking-tight text-content-primary">Explore</h1>
        <p className="text-sm text-content-secondary">
          What people made with CloudChef. Open one to try it, or make it your own.
        </p>
      </div>
      {posts.length === 0 ? (
        <p className="py-16 text-center text-sm text-content-secondary">
          Nothing here yet. Make a project public and publish it to be the first.
        </p>
      ) : (
        <PostGrid posts={posts} showAuthor />
      )}
      {next ? (
        <div className="flex justify-center">
          <Button variant="neutral" loading={loading} onClick={more}>
            More
          </Button>
        </div>
      ) : null}
    </main>
  );
}
