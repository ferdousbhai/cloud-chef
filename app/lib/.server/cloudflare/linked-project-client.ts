import { z } from 'zod';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import type { RuntimeConnectionIdentity } from './cloudflare-api-runtime-identity';
import { importedProjectRepo, type ProjectRepositories } from './project-repository';
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
  branch: z.string().min(1).max(256).nullable().optional(),
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
});
export type OpenedProject = z.infer<typeof openedProjectSchema>;

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
  importSource: importSourceSchema.optional(),
  /** Whether the project's site already builds in Workers Builds from the GitHub repository. */
  workersBuildsFromGitHub: z.boolean().optional(),
});

const errorSchema = z.object({ error: z.string() });

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
  if (response.status === 403 || response.status === 404) {
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
export async function readMemberIdentity(
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

/** Records that the project's repository now exists (idempotent); refused if another one is recorded. */
async function reportProjectImported(
  env: RuntimeEnv,
  identity: Identity,
  body: { orgProjectId: string; repo: string; commit: string },
): Promise<void> {
  const response = await postRuntimeRoute(env, identity, 'runtime-projects/imported', body, OPEN_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(await failureMessage(response, 'CloudChef could not record the imported project.'));
  }
  await response.body?.cancel().catch(() => undefined);
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
export async function projectSiteOrigins(env: RuntimeEnv, identity: Identity, orgProjectId: string): Promise<string[]> {
  const response = await postRuntimeRoute(env, identity, 'runtime-projects/site', { orgProjectId }, STATUS_TIMEOUT_MS);
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
    throw new Error("This project's code isn't in CloudChef yet, and there is nothing to import it from.");
  }
  const repo = importedProjectRepo(project.orgProjectId);
  const { commit } = await repositories.importFromUrl({
    url: project.importSource.url,
    authorization: project.importSource.authorization ?? null,
    branch: project.importSource.branch ?? null,
    repo,
  });
  await reportProjectImported(env, identity, { orgProjectId: project.orgProjectId, repo, commit });
  return repo;
}

async function readAnswer<T>(response: Response, schema: z.ZodType<T>, fallback: string): Promise<T> {
  if (!response.ok) {
    throw new Error(await failureMessage(response, fallback));
  }
  return schema.parse(await readJsonBodyWithLimit(response, MAX_JSON_RESPONSE_BYTES, 'Project response'));
}

async function failureMessage(response: Response, fallback: string): Promise<string> {
  const parsed = errorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : fallback;
}
