import type { BuilderDeploymentState } from '~/agents/builder-deployment-command';

/** What the browser knows of a CloudChef app's one site: where production serves, and its latest deployment. */
export type AppSiteState = {
  /** The address production serves at, as its last deployment recorded it. */
  url: string | null;
  /** The revision production serves, so the frame reloads when a deployment replaces it. */
  revision: string | null;
  deployment: BuilderDeploymentState | null;
};

export type AppSiteStatus = 'idle' | 'publishing' | 'failed' | 'live';

export type AppSitePresentation = {
  /** The site's address, when it is one the preview pane may frame. */
  url: string | null;
  revision: string | null;
  status: AppSiteStatus;
  error: string | null;
};

export function emptyAppSiteState(): AppSiteState {
  return { url: null, revision: null, deployment: null };
}

/**
 * A project's production Worker at its workers.dev address:
 * `https://cloudchef-<identity>.<account>.workers.dev` (see `appResourceName`).
 */
export function appSiteUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const workersDev =
      /^cloudchef-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/.test(
        url.hostname,
      );
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && workersDev ? url.href : null;
  } catch {
    return null;
  }
}

export function appSitePresentation(state: AppSiteState): AppSitePresentation {
  const deployment = state.deployment;
  const url = state.url ? appSiteUrl(state.url) : null;
  const status: AppSiteStatus =
    deployment?.status === 'deploying'
      ? 'publishing'
      : deployment?.status === 'failed'
        ? 'failed'
        : url
          ? 'live'
          : 'idle';
  return {
    url,
    revision: state.revision,
    status,
    error: status === 'failed' ? (deployment?.error ?? null) : null,
  };
}
