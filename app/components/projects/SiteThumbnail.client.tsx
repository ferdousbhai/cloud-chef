import { useEffect, useRef, useState } from 'react';

/** The width the site is laid out at before it's scaled down to the card. */
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 800;

/**
 * A live, scaled-down view of a published site. The frame loads only once the card is on screen, runs the
 * site's scripts in a sandbox without its own origin, and takes no input: the card's links are how to open
 * the site.
 */
export function SiteThumbnail({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [scale, setScale] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    const resize = new ResizeObserver(([entry]) => {
      if (entry) {
        setScale(entry.contentRect.width / FRAME_WIDTH);
      }
    });
    resize.observe(container);
    const intersection = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          intersection.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    intersection.observe(container);
    return () => {
      resize.disconnect();
      intersection.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className="relative aspect-16/10 overflow-hidden bg-bolt-elements-background-depth-2"
    >
      {visible && scale > 0 ? (
        <iframe
          src={url}
          title=""
          loading="lazy"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          tabIndex={-1}
          onLoad={() => setLoaded(true)}
          className={`pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-white motion-safe:transition-opacity motion-safe:duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
          style={{ width: FRAME_WIDTH, height: FRAME_HEIGHT, transform: `scale(${scale})` }}
        />
      ) : null}
    </div>
  );
}
