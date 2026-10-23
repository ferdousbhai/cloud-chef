import type { ReactNode } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { DotsHorizontalIcon, ExternalLinkIcon } from '@radix-ui/react-icons';
import { Menu } from '@ui/Menu';
import { ProjectTitle } from '~/components/ProjectTitle';
import { buttonClassNames } from '@ui/Button';
import { SiteThumbnail } from './SiteThumbnail.client';

/** One project on the projects home: what it looks like live, when it last changed, and what can be done. */
export function ProjectCard({
  title,
  updatedAt,
  siteUrl,
  badge,
  primary,
  menuItems,
}: {
  title: string;
  updatedAt: string | null;
  siteUrl: string | null;
  /** A short note beside the time, such as the person's access. */
  badge?: string;
  /** The main action: Edit, or nothing for a project the person may only view. */
  primary: ReactNode;
  menuItems: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 shadow-sm">
      {siteUrl ? (
        <SiteThumbnail url={siteUrl} />
      ) : (
        <div className="flex aspect-[16/10] items-center justify-center bg-bolt-elements-background-depth-2 text-xs text-content-tertiary">
          Not published yet
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3 border-t border-bolt-elements-borderColor p-3">
        <div className="min-w-0">
          <h3 className="truncate font-medium text-content-primary" title={title}>
            <ProjectTitle>{title}</ProjectTitle>
          </h3>
          <p className="truncate text-xs text-content-tertiary">
            {updatedAt ? (
              <>
                Updated{' '}
                <time dateTime={updatedAt}>{formatDistanceToNowStrict(new Date(updatedAt), { addSuffix: true })}</time>
              </>
            ) : null}
            {updatedAt && badge ? ' · ' : null}
            {badge}
          </p>
        </div>
        <div className="mt-auto flex min-w-0 items-center gap-2">
          {primary}
          {siteUrl ? (
            <a
              href={siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClassNames({ variant: 'neutral', size: 'xs' })}
              aria-label={`Open site: ${title}`}
            >
              <ExternalLinkIcon />
              Open site
            </a>
          ) : null}
          <div className="ml-auto">
            <Menu
              buttonProps={{
                variant: 'subtle',
                size: 'xs',
                title: `More for ${title}`,
                icon: <DotsHorizontalIcon />,
              }}
            >
              {menuItems}
            </Menu>
          </div>
        </div>
      </div>
    </li>
  );
}
