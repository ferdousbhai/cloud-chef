import { useEffect, useRef } from 'react';
import type { PostView } from '~/lib/showcase';
import { classNames } from '~/utils/classNames';

/**
 * A post's picture: its video when it has one (muted and looping, playing while it's on screen, or with controls on
 * the post's own page), else its screenshot, else its name on a soft field while the first screenshot is taken.
 */
export function PostMedia({
  post,
  variant,
  className,
  priority = false,
}: {
  post: Pick<PostView, 'title' | 'screenshot' | 'video'>;
  /** `tile` crops to the grid's shape; `card` and `page` show the whole picture. */
  variant: 'tile' | 'card' | 'page';
  className?: string;
  /** The first picture on a page, loaded at once. */
  priority?: boolean;
}) {
  const fit = variant === 'tile' ? 'object-cover object-top' : 'object-contain';
  if (post.video && variant !== 'tile') {
    return <PostVideo post={post} controls={variant === 'page'} className={classNames(fit, className)} />;
  }
  const picture = post.screenshot?.url ?? post.video?.posterUrl ?? null;
  if (picture) {
    return (
      <img
        src={picture}
        alt={`${post.title}, as it looks live`}
        width={post.screenshot?.width ?? 1280}
        height={post.screenshot?.height ?? 800}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        className={classNames('block size-full', fit, className)}
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
      <span className="line-clamp-2 text-lg font-semibold tracking-tight text-content-primary sm:text-xl">
        {post.title}
      </span>
    </div>
  );
}

function PostVideo({
  post,
  controls,
  className,
}: {
  post: Pick<PostView, 'title' | 'screenshot' | 'video'>;
  controls: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  // In a feed, a video plays while it's on screen and pauses when scrolled away, as a picture feed's do.
  useEffect(() => {
    const video = ref.current;
    if (!video || controls || !('IntersectionObserver' in window)) {
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          void video.play().catch(() => undefined);
        } else {
          video.pause();
        }
      },
      { threshold: 0.6 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [controls]);
  return (
    <video
      ref={ref}
      src={post.video!.url}
      poster={post.video!.posterUrl ?? post.screenshot?.url ?? undefined}
      muted
      loop
      playsInline
      controls={controls}
      preload="metadata"
      aria-label={`A short video of ${post.title}`}
      className={classNames('block size-full bg-black', className)}
    />
  );
}
