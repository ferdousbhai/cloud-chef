import type { PostView } from '~/lib/showcase';
import { classNames } from '~/utils/classNames';

/**
 * A post's picture: the screenshot of its live site, or its name on a soft field while the first screenshot is
 * taken.
 */
export function PostMedia({
  post,
  variant,
  className,
  priority = false,
}: {
  post: Pick<PostView, 'title' | 'screenshot'>;
  /** `tile` crops to the grid's shape; `card` and `page` show the whole picture. */
  variant: 'tile' | 'card' | 'page';
  className?: string;
  /** The first picture on a page, loaded at once. */
  priority?: boolean;
}) {
  if (post.screenshot) {
    return (
      <img
        src={post.screenshot.url}
        alt={`${post.title}, as it looks live`}
        width={post.screenshot.width}
        height={post.screenshot.height}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        className={classNames(
          'block size-full',
          variant === 'tile' ? 'object-cover object-top' : 'object-contain',
          className,
        )}
      />
    );
  }
  return (
    <div
      className={classNames(
        'showcase-placeholder flex size-full items-center justify-center p-4 text-center',
        className,
      )}
    >
      <span
        className={classNames('line-clamp-2 font-semibold tracking-tight text-content-primary', {
          'text-sm sm:text-lg': variant === 'tile',
          'text-lg sm:text-xl': variant !== 'tile',
        })}
      >
        {post.title}
      </span>
    </div>
  );
}
