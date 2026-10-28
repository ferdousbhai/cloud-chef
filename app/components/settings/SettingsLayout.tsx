import { DotsHorizontalIcon } from '@radix-ui/react-icons';
import type { ReactNode } from 'react';
import { Menu } from '@ui/Menu';
import { classNames } from '~/utils/classNames';

/**
 * One Settings card: a title, at most one short line under it, its one main action beside the title,
 * and the rest below.
 */
export function SettingsCard({
  id,
  title,
  description,
  action,
  children,
  className,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      className={classNames('app-card w-full min-w-0 p-4 wrap-anywhere sm:p-5', className)}
      aria-labelledby={headingId}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <h2 id={headingId} className="app-card-title">
            {title}
          </h2>
          {description ? <p className="mt-1 text-sm text-content-secondary">{description}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

type BadgeTone = 'success' | 'warning' | 'error' | 'neutral';

const BADGE_TONES = {
  success: 'text-content-success',
  warning: 'text-content-warning',
  error: 'text-content-error',
  neutral: 'text-content-secondary',
} satisfies Record<BadgeTone, string>;

/** A status in a word or two, in place of a sentence. */
export function StatusBadge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={classNames(
        'inline-flex max-w-full shrink-0 items-center gap-1.5 rounded border border-bolt-elements-borderColor px-1.5 py-0.5 text-xs leading-4',
        BADGE_TONES[tone],
      )}
    >
      {tone === 'neutral' ? null : <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** The "…" menu that holds a row's less common and destructive actions. */
export function MoreMenu({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Menu buttonProps={{ variant: 'subtle', size: 'xs', title, icon: <DotsHorizontalIcon aria-hidden /> }}>
      {children}
    </Menu>
  );
}
