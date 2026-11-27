import { GITHUB_ACCESS_FIX, GITHUB_UNREACHABLE } from '~/lib/github-return-messages';
import { z } from 'zod';
import { GitHubError } from '~/lib/.server/github/github-api';
import { gitHubAppFromEnv, type GitHubApp } from '~/lib/.server/github/github-app';
import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import {
  abandonImport,
  addUploadedProject,
  findAccessibleProject,
  projectOwnerName,
  publishesAsCollaborator,
  findReadableProject,
  listGitHubInstallations,
  recordImportedRepo,
  recordMainPush,
  removeProject,
  nameChatProject,
  requireProjectScope,
  type ProjectScope,
  type Project,
  type AccessibleProject,
} from '~/lib/cloudflare/data/org-projects.server';
import { findMembership } from '~/lib/cloudflare/data/organization-access.server';
import { importedProjectRepo } from '~/lib/.server/cloudflare/project-repository';
import { registerGitHubImport } from './projects';
import { deploymentOfCommit, latestDeployments } from '~/lib/cloudflare/data/project-deployments.server';
import { answeringOrganizationErrors } from './signed-in';
import { readAuthenticatedRuntimeRequest } from './runtime-authentication';

/**
 * A member's workspace runtime working on a project kept in Artifacts. The runtime reads and writes the
 * repository itself, through its Artifacts binding in the same account; it asks the control plane only
 * who may do what (checked on every call), for a one-repository GitHub token to import a project from,
 * and how its publishes went, which the control plane records.
 */
const MAX_REQUEST_BYTES = 8 * 1024;
const COMMIT = z.string().regex(/^[0-9a-f]{40}$/);
/** An Artifacts repository name as CloudChef makes a project's: `t-<project>`. */
const REPO = z.string().regex(/^t-[A-Za-z0-9_-]{1,120}$/);

const projectFields = { orgProjectId: z.string().uuid() };
const projectSchema = z.strictObject(projectFields);
const importedSchema = z.strictObject({ ...projectFields, repo: REPO, commit: COMMIT });
const statusSchema = z.strictObject({ ...projectFields, commit: COMMIT });
const abandonSchema = z.strictObject(projectFields);
const registerImportSchema = z.strictObject({
  url: z.string().min(1).max(2_048),
  name: z.string().trim().max(80).optional(),
});
const registerUploadSchema = z.strictObject({
  ...projectFields,
  name: z.string().trim().min(1).max(80),
  repo: REPO,
  /** A copy's source project, which the person must be able to read. */
  copiedFrom: z.string().uuid().optional(),
  /** Made empty, for history pushed from the person's own computer. */
  pushed: z.literal(true).optional(),
  /** Made in a chat with the agent, from CloudChef's starter. */
  chat: z.literal(true).optional(),
});
/**
 * What the runtime may do with a project: its repository (null until imported), the member's role, and,
 * while it is still to be imported and the member may edit it, where to import it from. A private
 * repository comes with a fresh GitHub App token limited to it, read-only, as git's Basic authorization.
 */
export async function runtimeOpenProjectAction(args: {
  request: Request;
  env: Env;
  app?: GitHubApp | null;
}): Promise<Response> {
  const opened = await openProject(args, projectSchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { project, identity, connection } = opened;
  const answer = {
    orgProjectId: project.id,
    name: project.name,
    repo: project.repo,
    defaultBranch: project.defaultBranch,
    role: project.role,
    member: await memberIdentity(args.env.DB, identity.userId),
    createdFrom: project.createdFrom,
    // Added to someone else's project: what they publish is held to what it already has, and whose it is.
    addedTo: (await publishesAsCollaborator(args.env.DB, project, connection.orgId, [identity.userId]))
      ? ((await projectOwnerName(args.env.DB, project.id)) ?? '')
      : null,
  };
  if (project.repo !== null || project.role !== 'edit') {
    return json(answer, 200);
  }
  const importSource = await importSourceFor(args, project);
  if (importSource instanceof Response) {
    return importSource;
  }
  return json(importSource ? { ...answer, importSource } : answer, 200);
}

/** Where git imports a project from: its address, and git's authorization for a private one. */
type ImportSource = { url: string; branch: string; authorization: string | null };

/** A GitHub import the runtime registered: the new project, and where to import it from. */
type RegisteredImport = { projectId: string; importSource: ImportSource };

/**
 * Where a project still to be imported comes from: its GitHub address, and for a private repository a fresh
 * GitHub App token limited to it, read-only, as git's Basic authorization. Null when it has no source.
 * `confirmedPublic` is a source GitHub has just shown is public, read as it is.
 */
async function importSourceFor(
  args: { env: Env; app?: GitHubApp | null; confirmedPublic?: boolean },
  project: Project,
): Promise<ImportSource | null | Response> {
  const source = project.importSource;
  if (!source) {
    return null;
  }
  const url = `https://github.com/${source.fullName}.git`;
  const publicSource = { url, branch: source.branch, authorization: null };
  if (source.repoId === null && args.confirmedPublic) {
    return publicSource;
  }
  const app = args.app === undefined ? gitHubAppFromEnv(args.env) : args.app;
  const installations = app ? await listGitHubInstallations(args.env.DB, project.connectionId) : [];
  // The installation on the account that owns the repository first; the others after, for one moved since.
  const owner = source.fullName.split('/')[0].toLowerCase();
  const ordered = [
    ...installations.filter((candidate) => candidate.accountLogin.toLowerCase() === owner),
    ...installations.filter((candidate) => candidate.accountLogin.toLowerCase() !== owner),
  ];
  let repoId = source.repoId;
  if (repoId === null) {
    // Added by its address as a public repository. It may have gone private since: then it is read through the
    // App if the App reaches it now, so giving the App access and opening the project again works.
    const [ownerInstallation] = ordered;
    if (!app || ownerInstallation?.accountLogin.toLowerCase() !== owner) {
      return publicSource;
    }
    try {
      const repositories = await app.installationRepositories(ownerInstallation.installationId);
      repoId =
        repositories.find((candidate) => candidate.full_name.toLowerCase() === source.fullName.toLowerCase())?.id ??
        null;
    } catch (error) {
      // Uninstalled there (404), or suspended (a 403 that isn't a rate limit): the App won't reach it, so the
      // repository is read as the public one it was.
      if (error instanceof GitHubError && (error.status === 404 || (error.status === 403 && !error.rateLimited))) {
        return publicSource;
      }
      if (error instanceof GitHubError) {
        // Not knowing whether the App reaches it now is not the same as its not doing so: try again.
        return json({ error: GITHUB_UNREACHABLE }, 503);
      }
      throw error;
    }
    if (repoId === null) {
      return publicSource;
    }
  }
  if (!app || ordered.length === 0) {
    return json(
      {
        code: 'github_disconnected',
        error:
          "CloudChef's GitHub App isn't connected to the GitHub account that holds this repository. To fix it, " +
          `${GITHUB_ACCESS_FIX}, then try again.`,
      },
      409,
    );
  }
  let refusal: GitHubError | null = null;
  for (const installation of ordered) {
    try {
      const token = await app.installationToken(installation.installationId, { contents: 'read' }, [repoId]);
      return { url, branch: source.branch, authorization: `Basic ${btoa(`x-access-token:${token}`)}` };
    } catch (error) {
      // GitHub saying no about this repository from this account: another may reach it. A 401 is CloudChef's
      // own App failing to sign in, which the person can't fix, so it is an outage, as is a rate limit.
      if (error instanceof GitHubError && !error.rateLimited && [403, 404, 422].includes(error.status)) {
        refusal ??= error;
        continue;
      }
      if (error instanceof GitHubError) {
        return json({ error: GITHUB_UNREACHABLE }, 503);
      }
      throw error;
    }
  }
  return json(
    {
      code: 'github_refused',
      error:
        refusal?.status === 403
          ? `GitHub refused CloudChef's GitHub App access to this repository. To fix it, ${GITHUB_ACCESS_FIX}, then try again.`
          : `CloudChef's GitHub App can no longer reach this repository. To fix it, ${GITHUB_ACCESS_FIX}, then try again.`,
    },
    502,
  );
}

/**
 * The runtime importing a GitHub repository as a new project of its account, which it then imports at once:
 * the project's id and where to import it from. In a team it takes one of the team's admins.
 */
export async function runtimeRegisterImportAction(args: {
  request: Request;
  env: Env;
  app?: GitHubApp | null;
  gitRequest?: typeof fetch;
}): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, registerImportSchema, {
    maxBytes: MAX_REQUEST_BYTES,
    label: 'Workspace runtime project import',
    invalid: INVALID_REQUEST,
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity, connection } = authenticated;
  return answeringOrganizationErrors(async () => {
    const scope = await requireProjectScope(args.env.DB, identity.userId, connection.orgId);
    if (scope.connectionId !== connection.id) {
      return json({ error: "This workspace can't open projects in that account." }, 403);
    }
    const app = args.app === undefined ? gitHubAppFromEnv(args.env) : args.app;
    const registered = await registerGitHubImport(args.env, {
      scope,
      actorId: identity.userId,
      request: body.name ? { url: body.url, name: body.name } : { url: body.url },
      app,
      gitRequest: args.gitRequest,
    });
    if (registered instanceof Response) {
      return registered;
    }
    const project = await findAccessibleProject(args.env.DB, registered.projectId, identity.userId);
    if (!project) {
      return json({ error: 'This project is not available to you.' }, 403);
    }
    let importSource: Awaited<ReturnType<typeof importSourceFor>>;
    try {
      importSource = await importSourceFor({ env: args.env, app, confirmedPublic: true }, project);
    } catch (error) {
      await removeProject(args.env.DB, { scope, projectId: project.id });
      throw error;
    }
    if (importSource instanceof Response) {
      // Nothing can be imported yet, so the project isn't kept: importing again starts afresh.
      await removeProject(args.env.DB, { scope, projectId: project.id });
      return importSource;
    }
    if (importSource === null) {
      throw new Error('A project registered from GitHub always has a source.');
    }
    const answer: RegisteredImport = { projectId: project.id, importSource };
    return json(answer, 201);
  });
}

/**
 * The runtime has written a ZIP someone uploaded to a new Artifacts repository (`t-<project id>`, the id the
 * runtime chose): record it as a project of its account. In a team it takes one of the team's admins, as an
 * import does.
 */
/** Said of a project that no longer exists: someone who ran it deleted it. */
const PROJECT_DELETED_MESSAGE = 'This project was deleted.';

/** Those of `projectIds` that no project has: deleted, as every project id a runtime holds was a project's once. */
async function deletedProjectIds(db: D1Database, projectIds: readonly string[]): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT value AS id FROM json_each(?1) WHERE value NOT IN (SELECT id FROM org_projects) ORDER BY value`,
    )
    .bind(JSON.stringify(projectIds))
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

const deletedProjectsSchema = z.strictObject({ orgProjectIds: z.array(z.string().uuid()).max(100) });

/**
 * `runtime-projects/deleted`: which of the projects a runtime holds workspaces of no longer exist, so it removes its
 * person's workspaces of them. Deleting a project asks every ready runtime in its account to remove them at once; this
 * is how one that wasn't ready then (or couldn't be reached) cleans up later. Only a project with no record at all is
 * answered, never one that exists but that the person may no longer open.
 */
export async function runtimeDeletedProjectsAction(args: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, deletedProjectsSchema, {
    maxBytes: MAX_REQUEST_BYTES,
    label: 'Workspace runtime deleted projects',
    invalid: INVALID_REQUEST,
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const ids = authenticated.body.orgProjectIds;
  return json({ deleted: ids.length === 0 ? [] : await deletedProjectIds(args.env.DB, ids) }, 200);
}

export async function runtimeRegisterUploadAction(args: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, registerUploadSchema, {
    maxBytes: MAX_REQUEST_BYTES,
    label: 'Workspace runtime project upload',
    invalid: INVALID_REQUEST,
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity, connection } = authenticated;
  if (body.repo !== importedProjectRepo(body.orgProjectId)) {
    return json({ error: 'That is not where this project is kept.' }, 409);
  }
  return answeringOrganizationErrors(async () => {
    // Anyone in a team who may make projects of their own there makes a chat's project as one of the team's, which
    // they may edit; adding any other project in a team takes one of its admins.
    let scope: ProjectScope;
    if (body.chat) {
      const membership = await findMembership(args.env.DB, connection.orgId, identity.userId);
      if (!membership?.draftsAllowed) {
        return json(
          { code: 'drafts_not_allowed', error: 'You work on the projects shared with you here, and start none.' },
          403,
        );
      }
      scope = { connectionId: connection.id, orgId: connection.orgId };
    } else {
      scope = await requireProjectScope(args.env.DB, identity.userId, connection.orgId);
    }
    if (scope.connectionId !== connection.id) {
      return json({ error: "This workspace can't add projects in that account." }, 403);
    }
    if (body.copiedFrom && !(await findReadableProject(args.env.DB, { id: body.copiedFrom }, identity.userId))) {
      return json({ error: 'That project is no longer one you can copy.' }, 403);
    }
    await addUploadedProject(args.env.DB, {
      scope,
      actorId: identity.userId,
      projectId: body.orgProjectId,
      name: body.name,
      repo: body.repo,
      copiedFrom: body.copiedFrom ?? null,
      createdFrom: body.chat ? 'chat' : body.copiedFrom ? 'copy' : body.pushed ? 'push' : 'zip',
    });
    return json({ projectId: body.orgProjectId }, 201);
  });
}

/** Who a member is, as the commits made in their name and their branch name them. */
export async function memberIdentity(db: D1Database, userId: string): Promise<{ name: string; email: string } | null> {
  const row = await db
    .prepare('SELECT name, email FROM "user" WHERE id = ?')
    .bind(userId)
    .first<{ name: string | null; email: string | null }>();
  if (!row?.email) {
    return null;
  }
  return { name: row.name?.trim() || row.email.split('@')[0], email: row.email };
}

/** The runtime has imported the project into its Artifacts repository: record it, once. */
export async function runtimeProjectImportedAction(args: { request: Request; env: Env }): Promise<Response> {
  const opened = await openProject(args, importedSchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { project, body } = opened;
  if (project.role !== 'edit') {
    return json({ error: 'Only someone who may edit this project can import it.' }, 403);
  }
  if (body.repo !== importedProjectRepo(project.id)) {
    return json({ error: 'That is not where this project is imported to.' }, 409);
  }
  if (!(await recordImportedRepo(args.env.DB, project.id, body.repo))) {
    return json({ code: 'already_imported', error: 'This project was already imported somewhere else.' }, 409);
  }
  return json({ orgProjectId: project.id, repo: body.repo }, 200);
}

/** The runtime taking back an import it registered whose code can never be copied (see `abandonImport`). */
export async function runtimeAbandonImportAction(args: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, abandonSchema, {
    maxBytes: MAX_REQUEST_BYTES,
    label: 'Workspace runtime import abandonment',
    invalid: INVALID_REQUEST,
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity, connection } = authenticated;
  const removed = await abandonImport(args.env.DB, {
    projectId: body.orgProjectId,
    userId: identity.userId,
    connectionId: connection.id,
  });
  return json({ removed }, 200);
}

const nameSchema = z.strictObject({ ...projectFields, name: z.string().trim().min(1).max(80) });

/** `runtime-projects/name`: the agent's title for a project made in a chat, set by the person who made it. */
export async function runtimeNameProjectAction(args: { request: Request; env: Env }): Promise<Response> {
  const opened = await openProject(args, nameSchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { project, body, identity } = opened;
  const named = await nameChatProject(args.env.DB, {
    projectId: project.id,
    actorId: identity.userId,
    name: body.name,
  });
  return named
    ? json({ name: body.name }, 200)
    : json({ error: 'Only a project its maker started in a chat is named this way.' }, 409);
}

const mainPushedSchema = z.strictObject({
  ...projectFields,
  oldCommit: COMMIT.nullable(),
  newCommit: COMMIT,
});

/**
 * `runtime-projects/main-pushed`: the runtime's person pushed the project's main, from `oldCommit` (null for its first
 * push) to `newCommit`, which their runtime's git proxy passed on to the repository. The push itself goes from the
 * runtime straight to Artifacts, so this is the only way CloudChef learns who published. Kept only for someone who may edit the project.
 */
export async function runtimeMainPushedAction(args: { request: Request; env: Env }): Promise<Response> {
  const opened = await openProject(args, mainPushedSchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { project, body, identity } = opened;
  if (project.role !== 'edit') {
    return json({ error: 'You can view this project but not change it.' }, 403);
  }
  await recordMainPush(args.env.DB, {
    projectId: project.id,
    userId: identity.userId,
    oldCommit: body.oldCommit,
    newCommit: body.newCommit,
    pushedAt: Date.now(),
  });
  return json({ recorded: true }, 200);
}

/** How the build and deploy of a commit of the project is going: none yet, queued, building, succeeded or failed. */
export async function runtimeProjectStatusAction(args: { request: Request; env: Env }): Promise<Response> {
  const opened = await openProject(args, statusSchema);
  if (opened instanceof Response) {
    return opened;
  }
  return json(await buildStatus(args.env.DB, opened.project.id, opened.body.commit), 200);
}

/**
 * The project's live site, for the model to read its content: the origins of its live address and its previews, as
 * its publishes recorded them; and for the workspace to show beside the chat, the live one and whether it may be
 * framed. Nothing the workspace says is trusted here: a workspace's own config could name any address.
 */
export async function runtimeProjectSiteAction(args: { request: Request; env: Env }): Promise<Response> {
  const opened = await openProject(args, projectSchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { project } = opened;
  const previews = (await latestDeployments(args.env.DB, project.id))
    .filter((deployment) => deployment.kind === 'preview' && deployment.state === 'succeeded' && deployment.url)
    .map((deployment) => new URL(deployment.url!).origin);
  const live = project.siteUrl ? [new URL(project.siteUrl).origin] : [];
  return json(
    { origins: [...new Set([...live, ...previews])], live: project.siteUrl, frameable: project.siteFrameable },
    200,
  );
}

/**
 * A commit's build and deploy as the runtime's build watch follows it. A deploy a newer commit superseded is
 * `cancelled`; `reason` says why one didn't go live.
 */
type BuildStatus = {
  state: 'none' | 'queued' | 'building' | 'succeeded' | 'failed' | 'cancelled';
  reason?: string;
  url?: string;
  previewUrl?: string;
};

async function buildStatus(db: D1Database, projectId: string, commit: string): Promise<BuildStatus> {
  const deployment = await deploymentOfCommit(db, { projectId, commit });
  if (!deployment) {
    return { state: 'none' };
  }
  const state =
    deployment.state === 'succeeded'
      ? 'succeeded'
      : deployment.state === 'failed'
        ? 'failed'
        : deployment.state === 'queued'
          ? 'queued'
          : deployment.state === 'building' || deployment.state === 'deploying'
            ? 'building'
            : deployment.state === 'superseded'
              ? 'cancelled'
              : 'none';
  const status: BuildStatus = { state };
  if (deployment.reason) {
    status.reason = deployment.reason;
  }
  if (deployment.url && deployment.kind === 'production') {
    status.url = deployment.url;
  } else if (deployment.url) {
    status.previewUrl = deployment.url;
  }
  return status;
}

/**
 * The project, with the member's role, if this runtime may ask about it: the runtime proves who it is,
 * the member may still view or edit the project, and the project belongs to the connection (the account)
 * the runtime runs for.
 */
export async function openProject<T extends z.infer<typeof projectSchema>>(
  args: { request: Request; env: Env },
  schema: z.ZodType<T>,
): Promise<
  | {
      project: AccessibleProject;
      body: T;
      connection: CloudflareConnection;
      identity: { userId: string };
      credentialHandle: string;
    }
  | Response
> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, schema, {
    maxBytes: MAX_REQUEST_BYTES,
    label: 'Workspace runtime project request',
    invalid: INVALID_REQUEST,
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity, connection, credentialHandle } = authenticated;
  const project = await findAccessibleProject(args.env.DB, body.orgProjectId, identity.userId);
  if (!project && (await deletedProjectIds(args.env.DB, [body.orgProjectId])).length > 0) {
    return json({ code: 'project_deleted', error: PROJECT_DELETED_MESSAGE }, 404);
  }
  if (!project || project.connectionId !== connection.id) {
    return json({ error: 'This project is not available to you.' }, 403);
  }
  return { project, body, connection, identity, credentialHandle };
}

const INVALID_REQUEST = 'Invalid workspace runtime project request.';

/** A JSON answer to the runtime. */
export function json<Answer>(body: Answer, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
