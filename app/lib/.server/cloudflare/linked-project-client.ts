import { z } from 'zod';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import {
  runtimeConnectionIdentity,
  type RuntimeConnectionEnv,
  type RuntimeConnectionIdentity,
} from './cloudflare-api-runtime-identity';
import { importedProjectRepo, type ProjectRepositories, type RepositoryAuthor } from './project-repository';
import { postRuntimeRoute } from './user-workspace-cloudflare-credential';

/**
 * A workspace runtime's side of working on a project the control plane keeps (a team's, or one imported
 * into a person's own account): the control plane says who may work on it and where its repository is, and
 * reports its builds and site from Workers Builds. The repository itself is this account's Artifacts, which
 * the runtime reads and writes directly (`project-repository.ts`).
 */
const OPEN_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 30_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024;

type RuntimeEnv = Pick<Env, 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT' | 'CONTROL_PLANE_SECRET'>;
type Identity = Pick<RuntimeConnectionIdentity, 'userId' | 'connectionId' | 'connectionGeneration'>;

const importSourceSchema = z.object({
  url: z.string().url(),
  branch: z.string().min(1).max(256),
  /** An `Authorization` header value for git over HTTPS (read-only, short-lived); none for a public repository. */
  authorization: z.string().min(1).max(4096).nullable().optional(),
});

const memberSchema = z.object({ name: z.string().min(1).max(256), email: z.string().min(3).max(320) });

const openedProjectSchema = z.object({
  orgProjectId: z.string().min(1),
  name: z.string().min(1).max(256),
  /** The project's Artifacts repository; null until its first open imports it. */
  repo: z.string().min(1).max(256).nullable(),
  defaultBranch: z.string().min(1).max(256),
  role: z.enum(['view', 'edit']),
  importSource: importSourceSchema.optional(),
  /** Who is asking, for the commits made in their name and their branch. */
  member: memberSchema.nullable().optional().catch(null),
  /** Who builds and deploys it: Workers Builds, or CloudChef itself (an upload). */
  deploysWith: z.enum(['workers_builds', 'cloudchef']).optional().catch(undefined),
});
type OpenedProject = z.infer<typeof openedProjectSchema>;

const buildStatusSchema = z.object({
  state: z.enum(['none', 'queued', 'building', 'succeeded', 'failed']),
  url: z.string().nullable().optional(),
  previewUrl: z.string().nullable().optional(),
  logUrl: z.string().nullable().optional(),
});
export type ProjectBuildStatus = z.infer<typeof buildStatusSchema>;

const siteOriginsSchema = z.object({ origins: z.array(z.string()).max(16) });

const productionRequestSentSchema = z.object({ outcome: z.enum(['requested', 'updated', 'unchanged']) });

const registeredImportSchema = z.object({
  projectId: z.string().min(1),
  importSource: importSourceSchema,
  /** Whether the project's site already builds in Workers Builds from the GitHub repository. */
  workersBuildsFromGitHub: z.boolean().optional(),
});

const refusalSchema = z.object({ error: z.string(), code: z.string().optional() });

/**
 * Thrown when the control plane refuses what was asked, in words for the person: a 4xx, or an answer naming
 * why (an import GitHub refused). Trying again unchanged gets the same answer, unlike an outage.
 */
export class ProjectRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRefusalError';
  }
}

/** Thrown when the control plane can't answer just now, with its words for the person: trying again may work. */
export class ProjectUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectUnavailableError';
  }
}

/** Thrown when the control plane refuses a project: no access (403), or no such project (404). */
export class ProjectAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ProjectAccessError';
  }
}

/**
 * The project as this person may use it: its name, repository, and their role. While it isn't imported
 * yet, the source to import it from comes with it.
 */
export async function openProject(env: RuntimeEnv, identity: Identity, orgProjectId: string): Promise<OpenedProject> {
  const response = await postRuntimeRoute(env, identity, 'runtime-projects/open', { orgProjectId }, OPEN_TIMEOUT_MS);
  // 401: the person was removed from the team or paused, which stops their runtime's every call.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new ProjectAccessError(
      await failureMessage(response, 'You no longer have access to this project.'),
      response.status,
    );
  }
  return readAnswer(response, openedProjectSchema, 'CloudChef could not open the project.');
}

const accessMemberSchema = z.object({ member: memberSchema.nullable().optional().catch(null) });

/**
 * Who this runtime's person is, as their commits name them: what the control plane's access answer
 * says, or null when it says nothing (or can't be reached), which a commit then names by user id.
 */
async function readMemberIdentity(
  env: RuntimeEnv,
  identity: Identity,
): Promise<{ name: string; email: string } | null> {
  try {
    const response = await postRuntimeRoute(env, identity, 'runtime-access');
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const parsed = accessMemberSchema.safeParse(
      await readJsonBodyWithLimit(response, MAX_JSON_RESPONSE_BYTES, 'Workspace access response'),
    );
    return parsed.success ? (parsed.data.member ?? null) : null;
  } catch {
    return null;
  }
}

/** Who commits made in this runtime are by: the person as the control plane names them, else by user id. */
export async function commitAuthor(env: RuntimeEnv & RuntimeConnectionEnv): Promise<RepositoryAuthor> {
  const identity = runtimeConnectionIdentity(env);
  const member = identity ? await readMemberIdentity(env, identity) : null;
  return member ?? { name: 'CloudChef member', email: `${env.CLOUDCHEF_USER_ID}@users.noreply.cloudchef.build` };
}

/** Records that the project's repository now exists (idempotent); refused if another one is recorded. */
async function reportProjectImported(
  env: RuntimeEnv,
  identity: Identity,
  body: { orgProjectId: string; repo: string; commit: string },
): Promise<void> {
  const response = await postRuntimeRoute(env, identity, 'runtime-projects/imported', body, OPEN_TIMEOUT_MS);
  if (!response.ok) {
    throw await failure(response, 'CloudChef could not record the imported project.');
  }
  await response.body?.cancel().catch(() => undefined);
}

/** Takes back an import this person just registered whose code can never be copied; best effort. */
export async function abandonProjectImport(
  env: RuntimeEnv,
  identity: Identity,
  orgProjectId: string,
): Promise<boolean> {
  try {
    const response = await postRuntimeRoute(env, identity, 'runtime-projects/abandon-import', { orgProjectId });
    const parsed = z
      .object({ removed: z.boolean() })
      .safeParse(await readJsonBodyWithLimit(response, MAX_JSON_RESPONSE_BYTES, 'Import abandonment response'));
    return response.ok && parsed.success && parsed.data.removed;
  } catch {
    return false;
  }
}

/** Asks the control plane to keep a repository from elsewhere as one of this person's projects. */
export async function registerProjectImport(
  env: RuntimeEnv,
  identity: Identity,
  body: { url: string; name: string },
): Promise<z.infer<typeof registeredImportSchema>> {
  const response = await postRuntimeRoute(env, identity, 'runtime-projects/register-import', body, OPEN_TIMEOUT_MS);
  return readAnswer(response, registeredImportSchema, 'CloudChef could not import that repository.');
}

/**
 * Asks the control plane to keep an uploaded project, whose code this runtime has already written to
 * `repo` (`t-<orgProjectId>`), as one of this person's projects (or their team's).
 */
export async function registerUploadedProject(
  env: RuntimeEnv,
  identity: Identity,
  body: { orgProjectId: string; name: string; repo: string },
): Promise<void> {
  const response = await postRuntimeRoute(env, identity, 'runtime-projects/register-upload', body, OPEN_TIMEOUT_MS);
  await readAnswer(response, z.object({ projectId: z.string() }), 'CloudChef could not add the project.');
}

/** What Workers Builds reports for a commit of the project so far. */
export async function projectBuildStatus(
  env: RuntimeEnv,
  identity: Identity,
  orgProjectId: string,
  commit: string,
): Promise<ProjectBuildStatus> {
  const response = await postRuntimeRoute(
    env,
    identity,
    'runtime-projects/status',
    { orgProjectId, commit },
    STATUS_TIMEOUT_MS,
  );
  return readAnswer(response, buildStatusSchema, 'CloudChef could not read the build status.');
}

/** The project's live site, as the https origins the control plane reports: its production and preview URLs. */
export async function projectSiteOrigins(
  env: RuntimeEnv,
  identity: Identity,
  orgProjectId: string,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<string[]> {
  const response = await postRuntimeRoute(env, identity, 'runtime-projects/site', { orgProjectId }, timeoutMs);
  return (await readAnswer(response, siteOriginsSchema, "CloudChef could not look up the project's site.")).origins;
}

/** Whether the admins now see a new request, this draft's request updated to the revision sent, or no change. */
export type ProductionRequestOutcome = z.infer<typeof productionRequestSentSchema>['outcome'];

/** Asks the team's admins to make a draft a real project; the draft's commit in its own repository is named. */
export async function requestProductionReview(
  env: RuntimeEnv,
  identity: Identity,
  body: {
    draftId: string;
    draftRevision: string;
    title: string;
    note: string;
    previewUrl: string | null;
    repo: string;
    commit: string;
  },
): Promise<{ outcome: ProductionRequestOutcome }> {
  const response = await postRuntimeRoute(env, identity, 'runtime-projects/request-production', body, OPEN_TIMEOUT_MS);
  return readAnswer(response, productionRequestSentSchema, 'CloudChef could not send the request.');
}

/**
 * The project's repository, imported first when the control plane says it has none yet: its source's
 * branch becomes main of `t-<project id>`, which the control plane then records. Another member's import
 * meanwhile is reused (the import is idempotent, and so is the record).
 */
export async function ensureProjectRepository(
  env: RuntimeEnv,
  identity: Identity,
  repositories: Pick<ProjectRepositories, 'importFromUrl'>,
  project: Pick<OpenedProject, 'orgProjectId' | 'repo' | 'importSource'>,
): Promise<string> {
  if (project.repo) {
    return project.repo;
  }
  if (!project.importSource) {
    throw new ProjectRefusalError(
      "This project's code isn't in CloudChef yet, and there is nothing to import it from.",
    );
  }
  const repo = importedProjectRepo(project.orgProjectId);
  const { commit } = await repositories.importFromUrl({
    url: project.importSource.url,
    authorization: project.importSource.authorization ?? null,
    branch: project.importSource.branch,
    repo,
  });
  await reportProjectImported(env, identity, { orgProjectId: project.orgProjectId, repo, commit });
  return repo;
}

async function readAnswer<T>(response: Response, schema: z.ZodType<T>, fallback: string): Promise<T> {
  if (!response.ok) {
    throw await failure(response, fallback);
  }
  return schema.parse(await readJsonBodyWithLimit(response, MAX_JSON_RESPONSE_BYTES, 'Project response'));
}

async function failureMessage(response: Response, fallback: string): Promise<string> {
  const parsed = refusalSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : fallback;
}

/**
 * A refused answer as a refusal; a server error that says what passed (GitHub unreachable) as unavailable, with its
 * words; one with nothing to say as a plain outage, worth retrying.
 */
async function failure(response: Response, fallback: string): Promise<Error> {
  const parsed = refusalSchema.safeParse(await response.json().catch(() => null));
  // The control plane crashing (`internal`) is an outage like no answer at all, however it is worded.
  if (!parsed.success || parsed.data.code === 'internal') {
    return new Error(fallback);
  }
  if (response.status < 500 || parsed.data.code !== undefined) {
    return new ProjectRefusalError(parsed.data.error);
  }
  // Words of its own (GitHub can't be reached) are said to the person.
  return new ProjectUnavailableError(parsed.data.error);
}

/** A build and deploy of one commit, as the control plane hands it to this runtime. */
const claimedDeploymentSchema = z.object({
  deploymentId: z.string().uuid(),
  claimed: z.boolean(),
  kind: z.enum(['production', 'preview']),
  state: z.string(),
  attempt: z.number().int().positive(),
  repo: z.string().min(1),
  workerName: z.string().nullable(),
});
type ClaimedDeployment = z.infer<typeof claimedDeploymentSchema>;

/** Claims building and deploying `commit` of `branch` of a project CloudChef deploys: once per commit. */
export async function claimProjectDeployment(
  env: RuntimeEnv,
  identity: Identity,
  body: { orgProjectId: string; branch: string; commit: string; headReadAt?: number },
): Promise<ClaimedDeployment> {
  const response = await postRuntimeRoute(env, identity, 'runtime-projects/deployments/claim', body, STATUS_TIMEOUT_MS);
  return readAnswer(response, claimedDeploymentSchema, 'CloudChef could not start the deploy.');
}

const retriedDeploymentSchema = z.object({
  deploymentId: z.string().uuid(),
  kind: z.enum(['production', 'preview']),
  branch: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  attempt: z.number().int().positive(),
});

/** Starts a failed deploy again, as a new attempt of the same commit. */
export async function retryProjectDeployment(
  env: RuntimeEnv,
  identity: Identity,
  body: { orgProjectId: string; deploymentId: string; toWantedWorker?: true },
): Promise<z.infer<typeof retriedDeploymentSchema>> {
  const response = await postRuntimeRoute(env, identity, 'runtime-projects/deployments/retry', body, STATUS_TIMEOUT_MS);
  return readAnswer(response, retriedDeploymentSchema, 'CloudChef could not start the deploy again.');
}

/**
 * What a report did: recorded; superseded by a newer commit (stop); refused (not this runtime's); busy (another
 * deploy of the project still runs: try the move to deploying again shortly); or worker_taken (another project
 * publishes to that Worker, and the deploy was recorded as failed).
 */
export type DeploymentReportOutcome = 'recorded' | 'superseded' | 'refused' | 'busy' | 'worker_taken';

export async function reportProjectDeployment(
  env: RuntimeEnv,
  identity: Identity,
  body: {
    orgProjectId: string;
    deploymentId: string;
    state: 'building' | 'deploying' | 'succeeded' | 'failed' | 'not_deployable';
    failureStage?: 'config' | 'install' | 'build' | 'migrations' | 'deploy' | 'interrupted';
    reason?: string;
    url?: string;
    workerName?: string;
    wantedWorkerName?: string;
  },
): Promise<DeploymentReport> {
  const response = await postRuntimeRoute(
    env,
    identity,
    'runtime-projects/deployments/report',
    body,
    STATUS_TIMEOUT_MS,
  );
  return readAnswer(response, deploymentReportSchema, 'CloudChef could not record the deploy.');
}

const deploymentReportSchema = z.object({
  outcome: z.enum(['recorded', 'superseded', 'refused', 'busy', 'worker_taken']),
  /** The Worker the project deploys as now, once one is held. */
  workerName: z.string().nullable(),
});

/** What a report did, and the Worker the project deploys as now. */
type DeploymentReport = z.infer<typeof deploymentReportSchema>;

/** The account's authorization, for the deploy step of a deployment this runtime is deploying, and only then. */
export async function projectDeploymentCredential(
  env: RuntimeEnv,
  identity: Identity,
  body: { orgProjectId: string; deploymentId: string; forceRefresh?: boolean },
): Promise<string> {
  const response = await postRuntimeRoute(
    env,
    identity,
    'runtime-projects/deployments/credential',
    body,
    STATUS_TIMEOUT_MS,
  );
  return (
    await readAnswer(
      response,
      z.object({ accessToken: z.string().min(1) }),
      'CloudChef could not authorize the deploy.',
    )
  ).accessToken;
}
