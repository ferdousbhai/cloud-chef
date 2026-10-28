import {
  recordProjectSiteUrl,
  recordWorkersBuildsScriptTag,
  type Project,
} from '~/lib/cloudflare/data/org-projects.server';
import type { CloudflareConnection } from './cloudflare-connection-repository';
import { openConnectionAccountApi } from './connection-account-api';
import { CANONICAL_ORIGIN } from '~/lib/.server/public-origin';
import { siteAllowsFraming } from '~/lib/.server/site-framing';
import type {
  UserCloudflareAccountApi,
  WorkerScriptSummary,
  WorkersBuild,
  WorkersBuildRepository,
  WorkersBuildTrigger,
} from './user-account-api';

/**
 * A project's builds and sites, from Workers Builds in the account the project belongs to. CloudChef never
 * builds or deploys a project kept in Artifacts itself: Workers Builds, connected to its repository, builds
 * `main` into production and other branches into Previews, and CloudChef reads what it reports.
 */
export type WorkersBuildsAccountApi = Pick<
  UserCloudflareAccountApi,
  | 'listWorkerScripts'
  | 'latestWorkersBuilds'
  | 'listWorkersBuilds'
  | 'listWorkersBuildTriggers'
  | 'listWorkerPreviews'
  | 'workerAddresses'
>;

export type OpenWorkersBuildsAccountApi = (
  env: Env,
  connection: Pick<CloudflareConnection, 'accountId' | 'credentialHandle'>,
) => Promise<WorkersBuildsAccountApi>;

/** The connection's account API, with its stored authorization, refreshed once if Cloudflare refuses it. */
export const openWorkersBuildsAccountApi: OpenWorkersBuildsAccountApi = openConnectionAccountApi;

/** Artifacts' only production branch, which Workers Builds deploys to production. */
export const PRODUCTION_BRANCH = 'main';

/** The Artifacts namespace every CloudChef project's repository is in. */
export const ARTIFACTS_NAMESPACE = 'cloudchef';

/** Where an admin connects a Worker to an Artifacts repository. */
export const WORKERS_BUILDS_CONNECT_URL = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages';

type ProjectWorker = WorkerScriptSummary;

/** Which of the project's repositories a Workers Builds repository is: its Artifacts one, or the GitHub one it came from. */
function projectRepositoryKind(
  repository: WorkersBuildRepository | null,
  project: Pick<Project, 'repo' | 'importSource'>,
): 'artifacts' | 'github' | null {
  if (!repository) {
    return null;
  }
  const source = project.importSource;
  if (repository.provider === 'github' && source) {
    const [owner, name] = source.fullName.toLowerCase().split('/');
    const sameId = source.repoId !== null && repository.repoId === String(source.repoId);
    const sameName = repository.accountName?.toLowerCase() === owner && repository.repoName?.toLowerCase() === name;
    return sameId || sameName ? 'github' : null;
  }
  // Artifacts is none of Workers Builds' other providers; its repositories are named as CloudChef named them.
  const otherProvider = repository.provider === 'github' || repository.provider?.startsWith('gitlab') === true;
  return !otherProvider && project.repo !== null && repository.repoName === project.repo ? 'artifacts' : null;
}

/**
 * The Worker Workers Builds builds the project into: the one recorded for it, or else the Worker whose
 * latest build came from the project's Artifacts repository, or from the GitHub repository it was imported
 * from (the same Worker, until its builds are switched). Null when there is none.
 */
export async function findProjectWorker(
  api: Pick<WorkersBuildsAccountApi, 'listWorkerScripts' | 'latestWorkersBuilds'>,
  project: Pick<Project, 'repo' | 'importSource' | 'workersBuildsScriptTag'>,
): Promise<ProjectWorker | null> {
  const scripts = await api.listWorkerScripts();
  const recorded = scripts.find((script) => script.tag === project.workersBuildsScriptTag);
  if (recorded) {
    return recorded;
  }
  let fromGitHub: ProjectWorker | null = null;
  for (let start = 0; start < scripts.length; start += 20) {
    const batch = scripts.slice(start, start + 20);
    const latest = await api.latestWorkersBuilds(batch.map((script) => script.tag));
    for (const script of batch) {
      const kind = projectRepositoryKind(latest.get(script.tag)?.repository ?? null, project);
      if (kind === 'artifacts') {
        return script;
      }
      if (kind === 'github') {
        fromGitHub ??= script;
      }
    }
  }
  return fromGitHub;
}

/** What Workers Builds reports for one commit of a project. */
type ProjectBuildStatus = {
  state: 'none' | 'queued' | 'building' | 'succeeded' | 'failed';
  /** The production site, for a build of main that succeeded. */
  url?: string;
  /** The branch's Preview, for a build of another branch that succeeded. */
  previewUrl?: string;
  /** The build in Cloudflare's dashboard. */
  logUrl?: string;
};

/** How many of a Worker's latest builds are searched for a commit: a publish asks about a recent one. */
const BUILDS_SEARCHED = 25;

export async function projectBuildStatus(
  api: WorkersBuildsAccountApi,
  args: { accountId: string; worker: ProjectWorker; commit: string },
): Promise<ProjectBuildStatus> {
  const builds = await api.listWorkersBuilds(args.worker.tag, BUILDS_SEARCHED);
  const build = builds.find((candidate) => candidate.commit === args.commit);
  if (!build) {
    return { state: 'none' };
  }
  const logUrl = buildLogUrl(args.accountId, args.worker.name, build.id);
  const state = buildState(build);
  if (state !== 'succeeded') {
    return { state, logUrl };
  }
  if (build.branch === PRODUCTION_BRANCH) {
    const [url] = await productionOrigins(api, args.worker);
    return url ? { state, url, logUrl } : { state, logUrl };
  }
  const previewUrl = build.branch ? await branchPreviewUrl(api, args.worker, build.branch) : null;
  return previewUrl ? { state, previewUrl, logUrl } : { state, logUrl };
}

function buildState(build: WorkersBuild): ProjectBuildStatus['state'] {
  switch (build.status) {
    case 'queued':
    case 'initializing':
      return 'queued';
    case 'running':
      return 'building';
    case 'stopped':
      // A skipped build built nothing for this commit; any other end but success is a failure.
      return build.outcome === 'success' ? 'succeeded' : build.outcome === 'skipped' ? 'none' : 'failed';
    default:
      return 'building';
  }
}

/** A build's page in Cloudflare's dashboard. */
function buildLogUrl(accountId: string, workerName: string, buildId: string): string {
  return `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/workers/services/view/${encodeURIComponent(
    workerName,
  )}/production/builds/${encodeURIComponent(buildId)}`;
}

/** The Worker's production origins: its custom domains, then its workers.dev address when it is served there. */
export async function productionOrigins(api: WorkersBuildsAccountApi, worker: ProjectWorker): Promise<string[]> {
  const { customDomains, workersDevUrl } = await api.workerAddresses(worker.tag);
  const origins = customDomains.map((hostname) => `https://${hostname}`);
  const workersDev = workersDevUrl ? originOf(workersDevUrl) : null;
  if (workersDev) {
    origins.push(workersDev);
  }
  return origins;
}

/** The origins of the Worker's Previews, which Workers Builds makes for branches other than main. */
export async function previewOrigins(api: WorkersBuildsAccountApi, worker: ProjectWorker): Promise<string[]> {
  const previews = await api.listWorkerPreviews(worker.tag);
  return previews.flatMap((preview) => preview.urls.flatMap((url) => originOf(url) ?? []));
}

/** The Preview a branch's builds update, when Workers Builds lists one for it. */
async function branchPreviewUrl(
  api: WorkersBuildsAccountApi,
  worker: ProjectWorker,
  branch: string,
): Promise<string | null> {
  const previews = await api.listWorkerPreviews(worker.tag);
  const slug = previewName(branch);
  const preview = previews.find((candidate) => candidate.names.some((name) => name === branch || name === slug));
  return preview?.urls[0] ?? null;
}

/** A branch name as a Preview's name in a hostname: lowercase letters, digits and dashes. */
function previewName(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Whether a Worker's builds come from the project's Artifacts repository, still from GitHub, or nothing. */
type WorkersBuildsConnection = {
  source: 'artifacts' | 'github' | 'none';
  worker: ProjectWorker | null;
  triggers: {
    name: string | null;
    branchIncludes: string[];
    branchExcludes: string[];
    buildCommand: string | null;
    deployCommand: string | null;
    rootDirectory: string | null;
    source: 'artifacts' | 'github' | null;
  }[];
};

/** How the project's Worker is built now, from its triggers. */
export async function projectWorkersBuildsConnection(
  api: WorkersBuildsAccountApi,
  project: Pick<Project, 'repo' | 'importSource' | 'workersBuildsScriptTag'>,
  worker: ProjectWorker | null,
): Promise<WorkersBuildsConnection> {
  if (!worker) {
    return { source: 'none', worker: null, triggers: [] };
  }
  const triggers = (await api.listWorkersBuildTriggers(worker.tag)).map((trigger: WorkersBuildTrigger) => ({
    name: trigger.name,
    branchIncludes: trigger.branchIncludes,
    branchExcludes: trigger.branchExcludes,
    buildCommand: trigger.buildCommand,
    deployCommand: trigger.deployCommand,
    rootDirectory: trigger.rootDirectory,
    source: projectRepositoryKind(trigger.repository, project),
  }));
  const source = triggers.some((trigger) => trigger.source === 'artifacts')
    ? 'artifacts'
    : triggers.some((trigger) => trigger.source === 'github')
      ? 'github'
      : 'none';
  return { source, worker, triggers };
}

/**
 * Finds the project's Worker in Workers Builds and records what the projects home shows of it: its tag,
 * and its live address while none is known or the Worker changed. A site that can't be read now is looked
 * for again next time.
 */
export async function recordProjectWorker(
  db: D1Database,
  api: WorkersBuildsAccountApi,
  project: Project,
  readProduction: (worker: ProjectWorker) => Promise<string[]> = (found) => productionOrigins(api, found),
): Promise<ProjectWorker | null> {
  const worker = await findProjectWorker(api, project);
  if (!worker) {
    return null;
  }
  if (worker.tag !== project.workersBuildsScriptTag) {
    await recordWorkersBuildsScriptTag(db, project.id, worker.tag);
  }
  if (!project.siteUrl || project.siteFrameable === null || worker.tag !== project.workersBuildsScriptTag) {
    const [siteUrl] = await readProduction(worker).catch((error: Error) => {
      console.warn({ event: 'project_site_unreadable', message: error.message });
      return [];
    });
    if (siteUrl) {
      const frameable = await siteAllowsFraming(siteUrl, CANONICAL_ORIGIN);
      await recordProjectSiteUrl(db, project.id, { url: siteUrl, frameable });
      project.siteUrl = siteUrl;
      project.siteFrameable = frameable;
    }
  }
  return worker;
}
