import { ChatBubbleIcon, HeartFilledIcon } from '@radix-ui/react-icons';
import type { PostView } from '~/lib/showcase';
import { countLabel } from '~/lib/showcase';
import { Avatar } from './Avatar';
import { PostMedia } from './PostMedia';
import { PostLink } from './ShowcaseLinks';

/**
 * Posts as a grid of pictures, newest first: a person's page and Explore. Each tile is the site's picture with its
 * name along the bottom; hovering shows its likes and comments. `showAuthor` names who made each (Explore).
 */
export function PostGrid({ posts, showAuthor = false }: { posts: PostView[]; showAuthor?: boolean }) {
  return (
    <ul className="grid grid-cols-2 gap-1.5 sm:gap-3 md:grid-cols-3">
      {posts.map((post, index) => (
        <li key={post.id} className="min-w-0">
          <PostLink
            path={post.path}
            className="showcase-tile group relative block aspect-[16/10] overflow-hidden no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--cc-accent)"
            label={`${post.title}${showAuthor ? `, by ${post.author.name}` : ''}: ${countLabel(post.likeCount, 'like')}, ${countLabel(post.commentCount, 'comment')}`}
          >
            <PostMedia
              post={post}
              variant="tile"
              priority={index < 6}
              className="transition-transform duration-300 group-hover:scale-[1.02]"
            />
            <span className="showcase-tile__veil pointer-events-none absolute inset-0" aria-hidden />
            <span className="pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-2 p-2 sm:p-3">
              {showAuthor ? (
                <Avatar name={post.author.name} image={post.author.image} size={22} className="hidden sm:inline-flex" />
              ) : null}
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-white sm:text-sm">{post.title}</span>
                {showAuthor ? (
                  <span className="block truncate text-[11px] text-white/80">@{post.author.username}</span>
                ) : null}
              </span>
            </span>
            <span
              className="showcase-tile__counts pointer-events-none absolute inset-0 hidden items-center justify-center gap-5 text-sm font-semibold text-white sm:flex"
              aria-hidden
            >
              <span className="inline-flex items-center gap-1.5">
                <HeartFilledIcon className="size-4" />
                {post.likeCount}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ChatBubbleIcon className="size-4" />
                {post.commentCount}
              </span>
            </span>
          </PostLink>
        </li>
      ))}
    </ul>
  );
}
