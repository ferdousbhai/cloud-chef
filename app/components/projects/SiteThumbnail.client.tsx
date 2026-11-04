import { useEffect, useRef, useState, type ReactNode } from 'react';
import { loadProjectThumbnail } from '~/lib/cloudflare/projects.client';

/** The first picture of a site takes a moment to be taken, so a card with none asks again after these. */
const RETRY_DELAYS_MS = [15_000, 45_000];

/**
 * A picture of a project's live site, taken in the account it belongs to, once the card is on screen; `fallback` until
 * there is one. A picture rather than the site in a frame, since a site that protects itself against clickjacking
 * refuses frames, and a picture runs none of its scripts here.
 */
export function SiteThumbnail({
  projectId,
  changedAt,
  fallback,
}: {
  projectId: string;
  /** When the project last changed, so a picture from before that is taken again. */
  changedAt: number | null;
  fallback: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
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
    return () => intersection.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const abort = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      loadProjectThumbnail(projectId, changedAt, abort.signal)
        .then((picture) => {
          if (picture) {
            setImage(URL.createObjectURL(picture));
            return;
          }
          const delay = RETRY_DELAYS_MS[attempt];
          if (delay !== undefined) {
            retry = setTimeout(() => load(attempt + 1), delay);
          }
        })
        // The card keeps what it shows; the next visit asks again.
        .catch(() => undefined);
    };
    load(0);
    return () => {
      abort.abort();
      clearTimeout(retry);
    };
  }, [visible, projectId, changedAt]);

  useEffect(() => (image ? () => URL.revokeObjectURL(image) : undefined), [image]);

  return (
    <div ref={containerRef} aria-hidden className="relative">
      {image ? (
        <img
          src={image}
          alt=""
          className="aspect-16/10 w-full bg-bolt-elements-background-depth-2 object-cover object-top"
        />
      ) : (
        fallback
      )}
    </div>
  );
}
