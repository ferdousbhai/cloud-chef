import { useEffect, useState, type ReactNode } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { DotsHorizontalIcon, ExternalLinkIcon, ReloadIcon } from '@radix-ui/react-icons';
import { Button, buttonClassNames } from '@ui/Button';
import { Menu } from '@ui/Menu';
import { Spinner } from '@ui/Spinner';
import { ProjectTitle } from '~/components/ProjectTitle';
import type { ProjectDeployment, ProjectDeploymentState } from '~/lib/cloudflare/org-projects.client';
import { SiteThumbnail } from './SiteThumbnail.client';

/** How a project CloudChef publishes itself is doing: its newest publish, and what can be done about it. */
export type CardDeploy = {
  /** The newest publish's state; null before the first. */
  state: ProjectDeploymentState | null;
  reason: string | null;
  /** What a running publish is doing now, and since when (milliseconds). */
  step?: ProjectDeployment['step'];
  stepStartedAt?: number | null;
  /** Publishes again after a failure; left out for someone who may only view the project. */
  onRetry?: () => void;
  retrying?: boolean;
  onShowLog?: () => void;
  /** Shows the publish's log as it runs. */
  onShowProgress?: () => void;
  /** Publishes to the Worker the project's config names, which was taken, instead of the one it went to. */
  onUseWantedWorker?: () => void;
};

/**
 * Whether a publish is still on its way. A superseded one counts, since a newer one is coming after it.
 */
export function deployInProgress(state: ProjectDeploymentState | null | undefined): boolean {
  return state === 'queued' || state === 'building' || state === 'deploying' || state === 'superseded';
}

/** One project on the projects home: what it looks like live, when it last changed, and what can be done. */
export function ProjectCard({
  title,
  updatedAt,
  updatedBy = null,
  siteUrl,
  siteFramed = true,
  subtitle,
  isPublic = false,
  badge,
  deploy,
  primary,
  menuItems,
}: {
  title: string;
  updatedAt: string | null;
  /** Who made that change, when it's known: a team project's last push of what it publishes. */
  updatedBy?: string | null;
  siteUrl: string | null;
  /** Whether the site may be shown live in the card; one that refuses is shown by its address. */
  siteFramed?: boolean;
  /** A second line under the title, such as the project's address on CloudChef. */
  subtitle?: string | null;
  /** Whether anyone signed in to CloudChef can find it in Explore. */
  isPublic?: boolean;
  /** A short note beside the time, such as the person's access. */
  badge?: string;
  /** For a project CloudChef publishes itself, how its newest publish went. */
  deploy?: CardDeploy;
  /** The main action: Edit, or nothing for a project the person may only view. */
  primary: ReactNode;
  menuItems: ReactNode;
}) {
  const publishing = deploy !== undefined && deployInProgress(deploy.state);
  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 shadow-xs">
      <div className="relative">
        <ProjectThumbnail
          siteUrl={siteUrl}
          siteFramed={siteFramed}
          placeholder={
            publishing ? (
              <div
                role="status"
                className="flex aspect-16/10 items-center justify-center gap-2 bg-bolt-elements-background-depth-2 text-xs text-content-secondary"
              >
                <Spinner />
                <PublishProgress deploy={deploy} />
              </div>
            ) : undefined
          }
          unpublished={deploy?.state === 'not_deployable' ? 'Code only' : 'Not published yet'}
        />
        {siteUrl && publishing ? (
          // The site stays up while its next version is published.
          <span
            role="status"
            className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 py-0.5 text-xs text-content-secondary shadow-xs"
          >
            <Spinner className="size-3" />
            {deploy?.step ? <PublishProgress deploy={deploy} /> : 'Updating…'}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3 border-t border-bolt-elements-borderColor p-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate font-medium text-content-primary" title={title}>
              <ProjectTitle>{title}</ProjectTitle>
            </h3>
            {isPublic ? <PublicBadge /> : null}
          </div>
          {subtitle ? (
            <p className="truncate text-xs text-content-secondary" title={subtitle}>
              {subtitle}
            </p>
          ) : null}
          <p className="truncate text-xs text-content-tertiary">
            {updatedAt ? (
              <>
                Updated{' '}
                <time dateTime={updatedAt}>{formatDistanceToNowStrict(new Date(updatedAt), { addSuffix: true })}</time>
                {updatedBy ? ` by ${updatedBy}` : null}
              </>
            ) : null}
            {updatedAt && badge ? ' · ' : null}
            {badge}
          </p>
        </div>
        {deploy ? <DeployNote deploy={deploy} siteShown={siteUrl !== null} title={title} /> : null}
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
                // By its address when it has one: a copy keeps its name, so two cards can share it.
                title: `More for ${subtitle ?? title}`,
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

/**
 * What a project looks like live: its site, shown small once the card scrolls into view; its address, for a
 * site that refuses to be framed; or, unpublished, `placeholder` when given and `unpublished` otherwise.
 */
export function ProjectThumbnail({
  siteUrl,
  siteFramed = true,
  placeholder,
  unpublished = 'Not published yet',
}: {
  siteUrl: string | null;
  siteFramed?: boolean;
  placeholder?: ReactNode;
  unpublished?: string;
}) {
  if (siteUrl && siteFramed) {
    return <SiteThumbnail url={siteUrl} />;
  }
  if (siteUrl) {
    // A site that refuses to be shown in a frame (as many do, against clickjacking) is named instead.
    return (
      <div className="flex aspect-16/10 items-center justify-center bg-bolt-elements-background-depth-2 px-4 text-center text-sm text-content-secondary">
        <span className="truncate">{siteHost(siteUrl)}</span>
      </div>
    );
  }
  return (
    placeholder ?? (
      <div className="flex aspect-16/10 items-center justify-center bg-bolt-elements-background-depth-2 text-xs text-content-tertiary">
        {unpublished}
      </div>
    )
  );
}

/** Says a project is public, beside its name. */
function PublicBadge() {
  return (
    <span
      className="shrink-0 rounded border border-bolt-elements-borderColor px-1.5 py-0.5 text-xs text-content-secondary"
      title="Anyone signed in to CloudChef can find it in Explore"
    >
      Public
    </span>
  );
}

const STEP_LABELS = {
  preparing: 'Setting up a build machine',
  installing: 'Installing the project’s packages',
  building: 'Building the site',
  migrating: 'Updating the database',
  publishing: 'Putting it live on Cloudflare',
} as const;

/** What a running publish is doing, and for how long it has been doing it. */
function PublishProgress({ deploy }: { deploy: CardDeploy }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!deploy.step) {
    return <>{deploy.state === 'queued' ? 'Waiting to start…' : 'Publishing…'}</>;
  }
  const seconds = deploy.stepStartedAt ? Math.max(0, Math.floor((now - deploy.stepStartedAt) / 1_000)) : null;
  return (
    <>
      {STEP_LABELS[deploy.step]}…{' '}
      {seconds === null ? null : (
        <span className="tabular-nums text-content-tertiary">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </span>
      )}
    </>
  );
}

/** Below the title, what went wrong with the newest publish, or why the project can't be published. */
function DeployNote({ deploy, siteShown, title }: { deploy: CardDeploy; siteShown: boolean; title: string }) {
  if (deployInProgress(deploy.state) && deploy.onShowProgress) {
    return (
      <div className="text-xs">
        <Button size="xs" variant="subtle" onClick={deploy.onShowProgress}>
          Show progress
        </Button>
      </div>
    );
  }
  if (deploy.state === 'failed') {
    return (
      <div role="alert" className="grid gap-2 text-xs">
        <p className="text-content-secondary">
          <span className="font-medium text-bolt-elements-icon-error">{"Didn't publish"}</span>
          {deploy.reason ? <>. {deploy.reason}</> : null}
        </p>
        <div className="flex flex-wrap gap-2">
          {deploy.onRetry ? (
            <Button
              size="xs"
              variant="neutral"
              icon={<ReloadIcon />}
              loading={deploy.retrying}
              aria-label={`Try publishing ${title} again`}
              onClick={deploy.onRetry}
            >
              Try again
            </Button>
          ) : null}
          {deploy.onShowLog ? (
            <Button size="xs" variant="subtle" onClick={deploy.onShowLog}>
              Show what happened
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  if (deploy.state === 'succeeded' && deploy.reason) {
    return (
      <div className="grid gap-2 text-xs">
        <p className="text-content-secondary">{deploy.reason}</p>
        {deploy.onUseWantedWorker ? (
          <div>
            <Button size="xs" variant="neutral" loading={deploy.retrying} onClick={deploy.onUseWantedWorker}>
              Use the existing Worker instead
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  if (deploy.state === 'not_deployable' && (siteShown || deploy.reason)) {
    // Without a site, the preview already says "Code only"; the note says why.
    return (
      <p className="text-xs text-content-secondary">
        {siteShown ? <span className="font-medium text-content-primary">Code only</span> : null}
        {siteShown && deploy.reason ? '. ' : null}
        {deploy.reason}
      </p>
    );
  }
  return null;
}

function siteHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Stand-ins shaped like project cards while a list loads, so the grid holds its place instead of jumping when the
 * cards arrive. Decorative: the caller keeps its own status text for screen readers.
 */
export function ProjectCardSkeletons({ count = 3 }: { count?: number }) {
  return (
    <ul aria-hidden className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <li
          key={index}
          className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 motion-safe:animate-pulse"
        >
          <div className="aspect-16/10 bg-bolt-elements-background-depth-2" />
          <div className="flex flex-col gap-2 border-t border-bolt-elements-borderColor p-3">
            <div className="h-4 w-2/3 rounded-sm bg-bolt-elements-background-depth-3" />
            <div className="h-3 w-1/3 rounded-sm bg-bolt-elements-background-depth-2" />
            <div className="mt-2 h-7 w-16 rounded bg-bolt-elements-background-depth-2" />
          </div>
        </li>
      ))}
    </ul>
  );
}
