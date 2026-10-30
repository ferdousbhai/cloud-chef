import { PlayIcon } from '@radix-ui/react-icons';
import { lazy, Suspense, useEffect, useState } from 'react';
import { reelTimelineSchema, type PostReel, type ReelTimeline } from '~/lib/reel';
import type { PostView } from '~/lib/showcase';
import { classNames } from '~/utils/classNames';

/** CloudChef's clip player, loaded only when someone plays a clip. */
const ReelPlayer = lazy(() => import('./ReelPlayer'));

/**
 * A post's picture: the screenshot of its live site, or its name on a soft field while the first screenshot is
 * taken. A post with a clip shows the clip's first picture with a play button in the feed and on its page, and plays
 * it in CloudChef's own player when pressed; a grid tile shows only that picture.
 */
export function PostMedia({
  post,
  variant,
  className,
  priority = false,
}: {
  post: Pick<PostView, 'title' | 'screenshot' | 'reel'>;
  /** `tile` crops to the grid's shape; `card` and `page` show the whole picture. */
  variant: 'tile' | 'card' | 'page';
  className?: string;
  /** The first picture on a page, loaded at once. */
  priority?: boolean;
}) {
  if (post.reel && variant !== 'tile') {
    return <PostReelView reel={post.reel} title={post.title} className={className} priority={priority} />;
  }
  const picture = post.reel?.poster ?? post.screenshot;
  if (picture && post.reel) {
    // A grid tile shows the clip's first picture, marked as a clip.
    return (
      <div className={classNames('relative size-full', className)}>
        <img
          src={picture.url}
          alt={`${post.title}, as it looks live`}
          width={picture.width}
          height={picture.height}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          className="block size-full object-cover object-top"
        />
        <span className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-black/60 text-white">
          <PlayIcon className="ml-px size-3.5" aria-label="Has a clip" />
        </span>
      </div>
    );
  }
  if (picture) {
    return (
      <img
        src={picture.url}
        alt={`${post.title}, as it looks live`}
        width={picture.width}
        height={picture.height}
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

/** A post's clip: its first picture until played, then the player with the timeline read from CloudChef's media. */
function PostReelView({
  reel,
  title,
  className,
  priority,
}: {
  reel: PostReel;
  title: string;
  className?: string;
  priority: boolean;
}) {
  const [asked, setAsked] = useState(false);
  const timeline = useReelTimeline(asked ? reel.url : null);
  const poster = (
    <img
      src={reel.poster.url}
      alt={`${title}, as it looks live`}
      width={reel.poster.width}
      height={reel.poster.height}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      className="block size-full object-contain"
    />
  );
  if (timeline === 'failed') {
    return <div className={classNames('relative size-full', className)}>{poster}</div>;
  }
  if (asked && timeline) {
    return (
      <div className={classNames('relative size-full', className)}>
        <Suspense fallback={poster}>
          <ReelPlayer timeline={timeline} fileUrl={(ref) => `/media/${ref}`} title={title} autoPlay />
        </Suspense>
      </div>
    );
  }
  return (
    <div className={classNames('relative size-full', className)}>
      {poster}
      <button
        type="button"
        onClick={() => setAsked(true)}
        className="absolute inset-0 flex items-center justify-center focus-visible:outline-none"
        aria-label={`Play ${title}’s clip`}
        aria-busy={asked}
      >
        <span className="flex size-14 items-center justify-center rounded-full bg-black/60 text-white shadow-lg ring-1 ring-white/25 backdrop-blur-sm">
          <PlayIcon className="ml-0.5 size-7" />
        </span>
      </button>
      <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
        Clip · {Math.max(1, Math.round(reel.seconds))}s
      </span>
    </div>
  );
}

/** A clip's timeline, read and checked once asked for: null while it loads, 'failed' when it can't be shown. */
function useReelTimeline(url: string | null): ReelTimeline | 'failed' | null {
  const [timeline, setTimeline] = useState<ReelTimeline | 'failed' | null>(null);
  useEffect(() => {
    if (!url) {
      return;
    }
    let current = true;
    readTimeline(url)
      .then((read) => {
        if (current) {
          setTimeline(read ?? 'failed');
        }
      })
      .catch(() => {
        if (current) {
          setTimeline('failed');
        }
      });
    return () => {
      current = false;
    };
  }, [url]);
  return timeline;
}

/** A stored timeline, checked as the player needs it; null when it is not one. */
async function readTimeline(url: string): Promise<ReelTimeline | null> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) {
    return null;
  }
  const parsed = reelTimelineSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}
