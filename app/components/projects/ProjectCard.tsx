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
  siteUrl,
  siteFramed = true,
  badge,
  deploy,
  primary,
  menuItems,
}: {
  title: string;
  updatedAt: string | null;
  siteUrl: string | null;
  /** Whether the site may be shown live in the card; one that refuses is shown by its address. */
  siteFramed?: boolean;
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
    <li className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 shadow-sm">
      <div className="relative">
        {siteUrl && siteFramed ? (
          <SiteThumbnail url={siteUrl} />
        ) : siteUrl ? (
          // A site that refuses to be shown in a frame (as many do, against clickjacking) is named instead.
          <div className="flex aspect-[16/10] items-center justify-center bg-bolt-elements-background-depth-2 px-4 text-center text-sm text-content-secondary">
            <span className="truncate">{siteHost(siteUrl)}</span>
          </div>
        ) : publishing ? (
          <div
            role="status"
            className="flex aspect-[16/10] items-center justify-center gap-2 bg-bolt-elements-background-depth-2 text-xs text-content-secondary"
          >
            <Spinner />
            <PublishProgress deploy={deploy} />
          </div>
        ) : (
          <div className="flex aspect-[16/10] items-center justify-center bg-bolt-elements-background-depth-2 text-xs text-content-tertiary">
            {deploy?.state === 'not_deployable' ? 'Code only' : 'Not published yet'}
          </div>
        )}
        {siteUrl && publishing ? (
          // The site stays up while its next version is published.
          <span
            role="status"
            className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 py-0.5 text-xs text-content-secondary shadow-sm"
          >
            <Spinner className="size-3" />
            {deploy?.step ? <PublishProgress deploy={deploy} /> : 'Updating…'}
          </span>
        ) : null}
      </div>
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
