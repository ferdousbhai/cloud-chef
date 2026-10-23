import { z } from 'zod';
import { gitHubAppFromEnv, type GitHubApp } from '~/lib/.server/github/github-app';
import { gitHubRepositoryFromUrl, publicRepositoryDefaultBranch } from '~/lib/.server/github/public-repository';
import { findActiveCloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { CloudflareAccountApiError } from '~/lib/.server/cloudflare/user-account-api';
import {
  ARTIFACTS_NAMESPACE,
  findProjectWorker,
  openWorkersBuildsAccountApi,
  PRODUCTION_BRANCH,
  projectWorkersBuildsConnection,
  WORKERS_BUILDS_CONNECT_URL,
  type OpenWorkersBuildsAccountApi,
} from '~/lib/.server/cloudflare/workers-builds';
import { readJsonRequest } from '~/lib/.server/request-guards';
import {
  approveProductionRequest,
  declineProductionRequest,
  importProject,
  listAccessibleProjects,
  recordWorkersBuildsScriptTag,
  removeProject,
  requireProjectScope,
  requireManagedProject,
  setProjectAccess,
  type Project,
} from '~/lib/cloudflare/data/org-projects.server';
import { OrganizationError } from '~/lib/cloudflare/data/organizations.server';
import { installedRepositories } from './github-projects';
import { signedIn } from './signed-in';

/**
 * Projects kept in Cloudflare Artifacts: a person's own and their team's. GitHub is only where one may be
 * imported from: a public repository by its address, a private one through CloudChef's GitHub App. The
 * first person to open an imported project imports it, in their workspace runtime.
 */
const scopeFields = { orgId: z.string().uuid().optional() };
const importSchema = z.union([
  z.strictObject({ ...scopeFields, repoId: z.number().int().positive(), name: z.string().trim().min(1).max(80) }),
  z.strictObject({ ...scopeFields, url: z.string().max(2_048), name: z.string().trim().max(80).optional() }),
]);
const projectSchema = z.strictObject({ ...scopeFields, projectId: z.string().uuid() });
const accessSchema = z.strictObject({
  orgId: z.string().uuid(),
  projectId: z.string().uuid(),
  userId: z.string().min(1).max(128),
  role: z.enum(['view', 'edit']).nullable(),
});
const approveSchema = z.strictObject({ orgId: z.string().uuid(), requestId: z.string().uuid() });
const declineSchema = z.strictObject({
  orgId: z.string().uuid(),
  requestId: z.string().uuid(),
  note: z.string().trim().max(1_000),
});

/** The projects this person may view or edit in the account they are working in now, with their role. */
export function listMyProjectsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const projects = session.context
      ? await listAccessibleProjects(env.DB, session.context.connectionId, session.user.id)
      : [];
    return Response.json(
      {
        projects: projects.map(({ id, name, repo, role, origin, importSource }) => ({
          id,
          name,
          repo,
          role,
          origin,
          importRepoFullName: importSource?.fullName ?? null,
        })),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  });
}

/**
 * Imports a GitHub repository as a project: one CloudChef's GitHub App reaches (`repoId`), or a public one
 * by its address (`url`). It becomes a project at once; its code comes into Artifacts when it is first
 * opened.
 */
export function importProjectAction({
  request,
  env,
  app = gitHubAppFromEnv(env),
  gitRequest = fetch,
}: {
  request: Request;
  env: Env;
  app?: GitHubApp | null;
  /** How github.com is asked whether a repository is public. */
  gitRequest?: typeof fetch;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, importSchema, 'Choose a repository and name the project.');
    if ('response' in body) {
      return body.response;
    }
    const scope = await requireProjectScope(env.DB, session.user.id, body.data.orgId);
    let source: NonNullable<Project['importSource']>;
    let name: string;
    if ('repoId' in body.data) {
      // Only a repository the installation actually reaches can become a project.
      const repositories = await installedRepositories(env.DB, scope, app);
      if (repositories instanceof Response) {
        return repositories;
      }
      const repoId = body.data.repoId;
      const repository = repositories.find((candidate) => candidate.id === repoId);
      if (!repository) {
        throw new OrganizationError("CloudChef's GitHub App can't reach that repository.", 404);
      }
      source = { repoId: repository.id, fullName: repository.full_name, branch: repository.default_branch };
      name = body.data.name;
    } else {
      const fullName = gitHubRepositoryFromUrl(body.data.url);
      if (!fullName) {
        return Response.json({ error: 'Paste the address of a repository on github.com.' }, { status: 400 });
      }
      const branch = await publicRepositoryDefaultBranch(fullName, gitRequest).catch(() => null);
      if (!branch) {
        return Response.json(
          {
            code: 'not_public',
            error: `${fullName} isn't a public repository with code in it. For a private one, connect GitHub first.`,
          },
          { status: 404 },
        );
      }
      source = { repoId: null, fullName, branch };
      name = body.data.name || fullName.split('/')[1];
    }
    const projectId = await importProject(env.DB, { scope, actorId: session.user.id, name, source });
    return Response.json({ projectId }, { status: 201 });
  });
}

/** Removes a project from CloudChef; its Artifacts repository and Worker stay in the account. */
export function removeProjectAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, projectSchema, 'Choose a project.');
    if ('response' in body) {
      return body.response;
    }
    const scope = await requireProjectScope(env.DB, session.user.id, body.data.orgId);
    await removeProject(env.DB, { scope, projectId: body.data.projectId });
    return new Response(null, { status: 204 });
  });
}

/** Gives a team member a role on a project (view or edit), or (null) takes it away. */
export function setProjectAccessAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, accessSchema, 'Choose a project, a member and a role.');
    if ('response' in body) {
      return body.response;
    }
    await setProjectAccess(env.DB, { ...body.data, actorId: session.user.id });
    return new Response(null, { status: 204 });
  });
}

/**
 * An admin approving a member's production request: the draft's own repository becomes a team project
 * its requester may edit. Workers Builds then deploys it once an admin connects the repository to it.
 */
export function approveProductionRequestAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, approveSchema, 'Choose a request.');
    if ('response' in body) {
      return body.response;
    }
    const approved = await approveProductionRequest(env.DB, { ...body.data, actorId: session.user.id });
    if (!approved) {
      throw new OrganizationError('That request was already decided, or its requester left the team.', 409);
    }
    return Response.json({
      projectId: approved.projectId,
      repo: approved.repo,
      workersBuilds: { namespace: ARTIFACTS_NAMESPACE, repo: approved.repo, connectUrl: WORKERS_BUILDS_CONNECT_URL },
    });
  });
}

export function declineProductionRequestAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, declineSchema, 'Choose a request.');
    if ('response' in body) {
      return body.response;
    }
    await declineProductionRequest(env.DB, { ...body.data, actorId: session.user.id });
    return new Response(null, { status: 204 });
  });
}

/** The route of a request about one project's Workers Builds. */
export const PROJECT_WORKERS_BUILDS_SWITCH_ROUTE = '/api/projects/:projectId/workers-builds/switch';
const PROJECT_PATH = /^\/api\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.+)$/;

/** The route pattern of a path naming one project (`/api/projects/<id>/…`), or null for any other path. */
export function projectRoute(pathname: string): string | null {
  const match = PROJECT_PATH.exec(pathname);
  return match ? `/api/projects/:projectId${match[2]}` : null;
}

/**
 * Moves the project's Worker's builds to its Artifacts repository, for the person who runs the project (its
 * owner, or one of its team's admins). Workers Builds' API names no Artifacts provider for a repository
 * connection and can't change a trigger's repository, so CloudChef can't make the move itself: it answers
 * `{ switched: true }` once the Worker builds from Artifacts, and otherwise what to do in Cloudflare's
 * dashboard (`instruction`, at `url`), naming the Worker and repository it found.
 */
export function switchProjectWorkersBuildsAction({
  request,
  env,
  openAccount = openWorkersBuildsAccountApi,
}: {
  request: Request;
  env: Env;
  openAccount?: OpenWorkersBuildsAccountApi;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const projectId = PROJECT_PATH.exec(new URL(request.url).pathname)?.[1] ?? '';
    const project = await requireManagedProject(env.DB, session.user.id, projectId);
    if (!project.repo) {
      return Response.json(
        {
          instruction:
            'Open the project once first: that brings its code into Artifacts. Then connect its Worker to the repository.',
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    const connection = await findActiveCloudflareConnection(env.DB, project.connectionId);
    if (!connection) {
      throw new OrganizationError('Connect the Cloudflare account first.', 409);
    }
    try {
      const api = await openAccount(env, connection);
      const worker = await findProjectWorker(api, project);
      if (worker && worker.tag !== project.workersBuildsScriptTag) {
        await recordWorkersBuildsScriptTag(env.DB, project.id, worker.tag);
      }
      const builds = await projectWorkersBuildsConnection(api, project, worker);
      if (builds.source === 'artifacts') {
        return Response.json({ switched: true }, { headers: { 'Cache-Control': 'private, no-store' } });
      }
      return Response.json(
        { instruction: switchInstruction(builds.worker?.name ?? null, project.repo), url: WORKERS_BUILDS_CONNECT_URL },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    } catch (error) {
      if (error instanceof CloudflareAccountApiError) {
        return Response.json({ error: `Workers Builds could not be read: ${error.message}` }, { status: 502 });
      }
      throw error;
    }
  });
}

/** How to move a Worker's builds to the project's Artifacts repository in Cloudflare's dashboard. */
function switchInstruction(workerName: string | null, repo: string): string {
  const worker = workerName ? `the Worker ${workerName}` : "the project's Worker";
  return (
    `In Workers & Pages, open ${worker}, then Settings, then Builds. Disconnect the GitHub repository (the site ` +
    `keeps serving), then connect the Artifacts namespace ${ARTIFACTS_NAMESPACE} and the repository ${repo}. Keep ` +
    `the build and deploy commands; production deploys from ${PRODUCTION_BRANCH}. Turn on builds for Preview branches.`
  );
}
