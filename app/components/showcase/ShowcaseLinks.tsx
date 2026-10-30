import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/**
 * Links between showcase pages, moving within the app rather than loading a new document, so going from a feed to a
 * post and back feels like one place.
 */
export function PersonLink({
  username,
  className,
  children,
  label,
}: {
  username: string | null;
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  if (!username) {
    return <span className={className}>{children}</span>;
  }
  return (
    <Link to="/$username" params={{ username }} className={className} aria-label={label}>
      {children}
    </Link>
  );
}

/** A post at its project's address, `/<owner>/<slug>`, with `hash` for a part of it (`comments`). */
export function PostLink({
  path,
  className,
  children,
  label,
  hash,
}: {
  path: string;
  className?: string;
  children: ReactNode;
  label?: string;
  hash?: string;
}) {
  const [, username = '', slug = ''] = path.split('/');
  return (
    <Link to="/$username/$slug" params={{ username, slug }} hash={hash} className={className} aria-label={label}>
      {children}
    </Link>
  );
}
