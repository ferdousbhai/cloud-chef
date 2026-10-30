import { ChatBubbleIcon, CopyIcon, ExternalLinkIcon, HeartFilledIcon, HeartIcon } from '@radix-ui/react-icons';
import type { PostView } from '~/lib/showcase';
import { countLabel } from '~/lib/showcase';
import { classNames } from '~/utils/classNames';
import { useShowcaseViewer } from './ViewerContext';

/**
 * The row under a post's picture, as in a picture feed: like, comment, make a copy, and open the live site, with the
 * like count beneath. Everyone sees the counts; liking needs sign-in.
 */
export function PostActions({
  post,
  onComment,
  onCopy,
}: {
  post: PostView;
  /** Opens or focuses the comments. */
  onComment: () => void;
  onCopy: () => void;
}) {
  const { liked, likeCount, toggleLike } = useShowcaseViewer();
  const isLiked = liked(post.id);
  const likes = likeCount(post.id, post.likeCount);
  return (
    <div className="grid gap-1">
      <div className="-ml-2 flex items-center gap-0.5">
        <button
          type="button"
          className={classNames('showcase-icon-button', { 'showcase-liked': isLiked })}
          aria-pressed={isLiked}
          aria-label={isLiked ? `Unlike ${post.title}` : `Like ${post.title}`}
          onClick={() => toggleLike(post.id, post.likeCount)}
        >
          {isLiked ? <HeartFilledIcon className="size-6" /> : <HeartIcon className="size-6" />}
        </button>
        <button
          type="button"
          className="showcase-icon-button"
          aria-label={`Comment on ${post.title}`}
          onClick={onComment}
        >
          <ChatBubbleIcon className="size-6" />
        </button>
        <button
          type="button"
          className="showcase-icon-button"
          aria-label={`Make a copy of ${post.title}`}
          onClick={onCopy}
        >
          <CopyIcon className="size-6" />
        </button>
        <a
          href={post.siteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-full bg-(--cc-accent) px-3.5 text-sm font-semibold text-(--cc-accent-ink) no-underline hover:opacity-90"
        >
          Open site
          <ExternalLinkIcon aria-hidden />
        </a>
      </div>
      <p className="text-sm font-semibold text-content-primary tabular-nums">
        {countLabel(likes, 'like')}
        {post.copyCount > 0 ? (
          <span className="font-normal text-content-secondary"> · {countLabel(post.copyCount, 'copy', 'copies')}</span>
        ) : null}
      </p>
    </div>
  );
}
