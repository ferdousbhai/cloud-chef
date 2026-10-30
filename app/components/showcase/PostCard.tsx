import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { PostView } from '~/lib/showcase';
import { countLabel, timeAgo } from '~/lib/showcase';
import { Avatar } from './Avatar';
import { Caption } from './Caption';
import { useCopyFromPost } from './CopyFromPost';
import { PostActions } from './PostActions';
import { PostMedia } from './PostMedia';
import { PostMenu } from './PostMenu';
import { PersonLink, PostLink } from './ShowcaseLinks';

/**
 * One post in the feed, as a picture feed shows it: who made it and when, the picture, the row of actions, the likes,
 * the caption, and a way into its comments.
 */
export function PostCard({ post: initial, priority = false }: { post: PostView; priority?: boolean }) {
  const [post, setPost] = useState(initial);
  const [gone, setGone] = useState(false);
  const navigate = useNavigate();
  const copy = useCopyFromPost({ id: post.projectId, name: post.title, path: post.path });
  if (gone) {
    return null;
  }
  const [, owner = '', slug = ''] = post.path.split('/');
  return (
    <article
      className="showcase-card overflow-hidden max-sm:rounded-none max-sm:border-x-0"
      aria-label={`${post.title}, by ${post.author.name}`}
    >
      <header className="flex items-center gap-2.5 px-3 py-2.5">
        <PersonLink username={post.author.username} className="shrink-0" label={`${post.author.name}’s page`}>
          <Avatar name={post.author.name} image={post.author.image} size={34} />
        </PersonLink>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm">
            <PersonLink
              username={post.author.username}
              className="font-semibold text-content-primary no-underline hover:underline"
            >
              {post.author.username}
            </PersonLink>
            <span className="text-content-tertiary"> · {timeAgo(post.shownAt)}</span>
            {post.updated ? (
              <span className="showcase-chip ml-2 px-1.5 py-px align-middle text-[11px]">Updated</span>
            ) : null}
          </p>
          <PostLink
            path={post.path}
            className="block truncate text-xs text-content-secondary no-underline hover:underline"
          >
            {post.title}
          </PostLink>
        </div>
        <PostMenu
          post={post}
          onCaption={(caption) => setPost({ ...post, caption })}
          onChanged={() => window.location.reload()}
          onGone={() => setGone(true)}
        />
      </header>
      <PostLink
        path={post.path}
        className="block aspect-[16/10] overflow-hidden bg-[#0c0d12]"
        label={`Open ${post.title}`}
      >
        <PostMedia post={post} variant="card" priority={priority} />
      </PostLink>
      <div className="grid gap-1.5 px-3 pb-3.5 pt-1.5">
        <PostActions
          post={post}
          onComment={() =>
            void navigate({ to: '/$username/$slug', params: { username: owner, slug }, hash: 'comments' })
          }
          onCopy={copy.start}
        />
        {post.caption ? <Caption username={post.author.username} text={post.caption} /> : null}
        {post.commentCount > 0 ? (
          <PostLink
            path={post.path}
            hash="comments"
            className="text-sm text-content-tertiary no-underline hover:underline"
          >
            {post.commentCount === 1 ? 'View 1 comment' : `View all ${countLabel(post.commentCount, 'comment')}`}
          </PostLink>
        ) : null}
      </div>
      {copy.dialog}
    </article>
  );
}
