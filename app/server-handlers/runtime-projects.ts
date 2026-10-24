import { z } from 'zod';
import { GitHubError } from '~/lib/.server/github/github-api';
import { gitHubAppFromEnv, type GitHubApp } from '~/lib/.server/github/github-app';
import { CloudflareAccountApiError } from '~/lib/.server/cloudflare/user-account-api';
import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import {
  findProjectWorker,
  openWorkersBuildsAccountApi,
  previewOrigins,
  productionOrigins,
  projectBuildStatus,
  type OpenWorkersBuildsAccountApi,
  type WorkersBuildsAccountApi,
} from '~/lib/.server/cloudflare/workers-builds';
import {
  findAccessibleProject,
  findGitHubInstallation,
  recordImportedRepo,
  recordProjectSiteUrl,
  recordWorkersBuildsScriptTag,
  requireProjectScope,
  type Project,
  type ProjectRole,
} from '~/lib/cloudflare/data/org-projects.server';
import { findMembership } from '~/lib/cloudflare/data/organization-access.server';
import { nativeProjectRepo } from '~/lib/.server/cloudflare/project-repository';
import { registerGitHubImport } from './projects';
import { answeringOrganizationErrors } from './signed-in';
import { readAuthenticatedRuntimeRequest } from './runtime-authentication';

/**
 * A member's workspace runtime working on a project kept in Artifacts. The runtime reads and writes the
 * repository itself, through its Artifacts binding in the same account; it asks the control plane only
 * who may do what (checked on every call), for a one-repository GitHub token to import a project from,
 * and what Workers Builds reports, which needs the account's Cloudflare authorization the runtime never
 * holds for a team.
 */
const MAX_REQUEST_BYTES = 8 * 1024;
const COMMIT = z.string().regex(/^[0-9a-f]{40}$/);
/** An Artifacts repository name as CloudChef makes them: `p-<chat>` for a draft, `t-<project>` for an import. */
const REPO = z.string().regex(/^[pt]-[A-Za-z0-9_-]{1,120}$/);

const projectFields = { orgProjectId: z.string().uuid() };
const projectSchema = z.strictObject(projectFields);
const importedSchema = z.strictObject({ ...projectFields, repo: REPO, commit: COMMIT });
const statusSchema = z.strictObject({ ...projectFields, commit: COMMIT });
const registerImportSchema = z.strictObject({
  url: z.string().min(1).max(2_048),
  name: z.string().trim().max(80).optional(),
});
const MAX_PENDING_REQUESTS_PER_MEMBER = 5;
const productionRequestSchema = z.strictObject({
  /** The builder holding the draft, and the validated revision sent: the same draft sent again replaces its request. */
  draftId: z.string().min(1).max(256),
  draftRevision: z.string().min(1).max(256),
  title: z.string().trim().min(1).max(80),
  /** The draft's own repository (`p-<chat>`), and the commit of it an admin reviews. */
  repo: z.string().regex(/^p-[A-Za-z0-9_-]{1,120}$/),
  commit: COMMIT,
  note: z.string().trim().max(1_000).default(''),
  /** The draft's deployment, which admins open: only a workers.dev address over https. */
  previewUrl: z.url().max(2_048).refine(isWorkersDevUrl).nullable().default(null),
});

/** The Artifacts repository an imported project is given. */
function importedRepoName(projectId: string): string {
  return `t-${projectId}`;
}

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
  const { project, identity } = opened;
  const answer = {
    orgProjectId: project.id,
    name: project.name,
    repo: project.repo,
    defaultBranch: project.defaultBranch,
    role: project.role,
    member: await memberIdentity(args.env.DB, identity.userId),
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

/** A GitHub import the runtime registered: the new project, and where to import it from when it has a source. */
type RegisteredImport = { projectId: string; importSource?: ImportSource; workersBuildsFromGitHub: boolean };

/**
 * Where a project still to be imported comes from: its GitHub address, and for a private repository a fresh
 * GitHub App token limited to it, read-only, as git's Basic authorization. Null when it has no source.
 */
async function importSourceFor(
  args: { env: Env; app?: GitHubApp | null },
  project: Project,
): Promise<ImportSource | null | Response> {
  const source = project.importSource;
  if (!source) {
    return null;
  }
  const url = `https://github.com/${source.fullName}.git`;
  if (source.repoId === null) {
    return { url, branch: source.branch, authorization: null };
  }
  const app = args.app === undefined ? gitHubAppFromEnv(args.env) : args.app;
  const installation = await findGitHubInstallation(args.env.DB, project.connectionId);
  if (!app || !installation) {
    return json(
      { code: 'github_disconnected', error: 'Connect GitHub again in Settings to import this project.' },
      409,
    );
  }
  try {
    const token = await app.installationToken(installation.installationId, { contents: 'read' }, [source.repoId]);
    return { url, branch: source.branch, authorization: `Basic ${btoa(`x-access-token:${token}`)}` };
  } catch (error) {
    if (error instanceof GitHubError) {
      return json(
        {
          code: 'github_refused',
          error:
            error.status === 404 || error.status === 422
              ? "CloudChef's GitHub App can no longer reach this repository. Give it access on GitHub, then try again."
              : error.message,
        },
        502,
      );
    }
    throw error;
  }
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
    const scope = await requireProjectScope(args.env.DB, identity.userId, connection.orgId ?? undefined);
    if (scope.connectionId !== connection.id) {
      return json({ error: 'This runtime does not work in that account.' }, 403);
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
    const importSource = await importSourceFor({ env: args.env, app }, project);
    if (importSource instanceof Response) {
      return importSource;
    }
    // A project with no source (none yet) is imported from nowhere: the runtime is told only its id.
    const answer: RegisteredImport = {
      projectId: project.id,
      workersBuildsFromGitHub: await buildsFromGitHub(args.env, connection, project),
    };
    if (importSource) {
      answer.importSource = importSource;
    }
    return json(answer, 201);
  });
}

/** Whether Workers Builds already deploys a Worker from this project's GitHub repository. */
async function buildsFromGitHub(env: Env, connection: CloudflareConnection, project: Project): Promise<boolean> {
  try {
    const opened = await openWorkersBuildsAccountApi(env, connection);
    return (await findProjectWorker(opened, project)) !== null;
  } catch {
    // Unknown is shown as no: the switch can still be offered from the project later.
    return false;
  }
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
  if (body.repo !== importedRepoName(project.id)) {
    return json({ error: 'That is not where this project is imported to.' }, 409);
  }
  if (!(await recordImportedRepo(args.env.DB, project.id, body.repo))) {
    return json({ code: 'already_imported', error: 'This project was imported into another repository.' }, 409);
  }
  return json({ orgProjectId: project.id, repo: body.repo }, 200);
}

/** What Workers Builds reports for a commit of the project: none yet, queued, building, succeeded or failed. */
export async function runtimeProjectStatusAction(args: {
  request: Request;
  env: Env;
  openAccount?: OpenWorkersBuildsAccountApi;
}): Promise<Response> {
  const opened = await openProject(args, statusSchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { project, body, connection } = opened;
  return withWorkersBuilds(args, connection, project, async (api, worker) =>
    worker
      ? json(await projectBuildStatus(api, { accountId: connection.accountId, worker, commit: body.commit }), 200)
      : json({ state: 'none' }, 200),
  );
}

/**
 * The project's live site, for the model to read its content: the origins its Worker serves in production
 * and its Previews, as Cloudflare reports them. Nothing the workspace says is trusted here: a workspace's
 * own config could name any address.
 */
export async function runtimeProjectSiteAction(args: {
  request: Request;
  env: Env;
  openAccount?: OpenWorkersBuildsAccountApi;
}): Promise<Response> {
  const opened = await openProject(args, projectSchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { project, connection } = opened;
  return withWorkersBuilds(args, connection, project, async (api, worker) => {
    if (!worker) {
      return json({ origins: [] }, 200);
    }
    const [production, previews] = await Promise.all([
      productionOrigins(api, worker),
      previewOrigins(api, worker).catch(() => []),
    ]);
    return json({ origins: [...new Set([...production, ...previews])] }, 200);
  });
}

/**
 * The project's Worker in Workers Builds (found once, then remembered), and the account's API to ask
 * about it. Cloudflare refusing answers 502 with what it said.
 */
async function withWorkersBuilds(
  args: { env: Env; openAccount?: OpenWorkersBuildsAccountApi },
  connection: CloudflareConnection,
  project: Project,
  answer: (api: WorkersBuildsAccountApi, worker: Awaited<ReturnType<typeof findProjectWorker>>) => Promise<Response>,
): Promise<Response> {
  try {
    const api = await (args.openAccount ?? openWorkersBuildsAccountApi)(args.env, connection);
    const worker = await findProjectWorker(api, project);
    if (worker && worker.tag !== project.workersBuildsScriptTag) {
      await recordWorkersBuildsScriptTag(args.env.DB, project.id, worker.tag);
    }
    if (worker && (!project.siteUrl || worker.tag !== project.workersBuildsScriptTag)) {
      // The projects home shows the site; a site that can't be read now is looked for on the next call.
      const [siteUrl] = await productionOrigins(api, worker).catch(() => []);
      if (siteUrl) {
        await recordProjectSiteUrl(args.env.DB, project.id, siteUrl);
      }
    }
    return await answer(api, worker);
  } catch (error) {
    if (error instanceof CloudflareAccountApiError) {
      return json({ error: `Workers Builds could not be read: ${error.message}` }, 502);
    }
    throw error;
  }
}

/**
 * A member asking for a draft built in the organization's account to become a team project: an admin
 * reviews it and, approving, adopts the draft's own repository as the project's.
 */
export async function runtimeRequestProductionAction(args: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, productionRequestSchema, {
    maxBytes: MAX_REQUEST_BYTES,
    label: 'Workspace runtime project request',
    invalid: INVALID_REQUEST,
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const orgId = authenticated.connection.orgId;
  if (!orgId) {
    return json({ error: "Production requests are for a team's drafts." }, 409);
  }
  // A member limited to the team's projects has no drafts of their own to send.
  const membership = await findMembership(args.env.DB, orgId, authenticated.identity.userId);
  if (!membership?.draftsAllowed) {
    return json({ code: 'drafts_not_allowed', error: 'Your team lets you work on its team projects only.' }, 403);
  }
  // The repository named is the draft's own (its chat's, or one of its subchats'), never another app's.
  const { draftId, repo } = authenticated.body;
  const draftRepo = nativeProjectRepo(draftId);
  if (repo !== draftRepo && !new RegExp(`^${draftRepo}-[1-9][0-9]{0,5}$`).test(repo)) {
    return json({ error: "That is not this draft's repository." }, 400);
  }
  return sendProductionRequest(
    args.env.DB,
    orgId,
    { ...authenticated.body, userId: authenticated.identity.userId },
    true,
  );
}

/** A draft's deployment: https on workers.dev, with no credentials or port. */
function isWorkersDevUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    url.hostname.endsWith('.workers.dev') &&
    url.hostname.length > '.workers.dev'.length
  );
}

type ProductionRequestBody = z.infer<typeof productionRequestSchema> & { userId: string };

/**
 * A draft has at most one open request: sent again (an improved revision, a reload, a second tab), it
 * replaces what the admins see, keeping its place in their list.
 */
async function sendProductionRequest(
  db: D1Database,
  orgId: string,
  body: ProductionRequestBody,
  retryOnRace: boolean,
): Promise<Response> {
  const open = await db
    .prepare(
      `SELECT id, title, note, draft_revision, commit_sha FROM production_requests
       WHERE org_id = ? AND requested_by = ? AND status = 'pending' AND draft_id = ?`,
    )
    .bind(orgId, body.userId, body.draftId)
    .first<{ id: string; title: string; note: string | null; draft_revision: string; commit_sha: string | null }>();
  if (open) {
    if (
      open.draft_revision === body.draftRevision &&
      open.commit_sha === body.commit &&
      open.title === body.title &&
      (open.note ?? '') === body.note
    ) {
      return json({ requestId: open.id, outcome: 'unchanged' }, 200);
    }
    const updated = await db
      .prepare(
        `UPDATE production_requests
         SET draft_revision = ?, title = ?, note = ?, preview_url = ?, repo = ?, commit_sha = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(
        body.draftRevision,
        body.title,
        body.note || null,
        body.previewUrl,
        body.repo,
        body.commit,
        Date.now(),
        open.id,
      )
      .run();
    return updated.meta.changes === 1
      ? json({ requestId: open.id, outcome: 'updated' }, 200)
      : json({ error: `“${open.title}” was decided just now. Send it again to ask once more.` }, 409);
  }
  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(title = ? COLLATE NOCASE), 0) AS same_title
       FROM production_requests WHERE requested_by = ? AND org_id = ? AND status = 'pending'`,
    )
    .bind(body.title, body.userId, orgId)
    .first<{ count: number; same_title: number }>();
  if ((pending?.same_title ?? 0) > 0) {
    return json(
      { error: `Another app of yours named “${body.title}” is waiting for review. Give this one its own name.` },
      409,
    );
  }
  if ((pending?.count ?? 0) >= MAX_PENDING_REQUESTS_PER_MEMBER) {
    return json({ error: 'You already have several requests waiting. An admin will get to them.' }, 429);
  }
  const id = crypto.randomUUID();
  // Ignored only when another send for the same draft got in first: that one is then replaced instead.
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO production_requests
         (id, org_id, requested_by, draft_id, draft_revision, title, note, preview_url, repo, commit_sha, status,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(
      id,
      orgId,
      body.userId,
      body.draftId,
      body.draftRevision,
      body.title,
      body.note || null,
      body.previewUrl,
      body.repo,
      body.commit,
      Date.now(),
    )
    .run();
  if (inserted.meta.changes === 1) {
    return json({ requestId: id, outcome: 'requested' }, 201);
  }
  if (!retryOnRace) {
    throw new Error('The production request was neither recorded nor found.');
  }
  return sendProductionRequest(db, orgId, body, false);
}

/**
 * The project, with the member's role, if this runtime may ask about it: the runtime proves who it is,
 * the member may still view or edit the project, and the project belongs to the connection (the account)
 * the runtime runs for.
 */
async function openProject<T extends z.infer<typeof projectSchema>>(
  args: { request: Request; env: Env },
  schema: z.ZodType<T>,
): Promise<
  | {
      project: Project & { role: ProjectRole };
      body: T;
      connection: CloudflareConnection;
      identity: { userId: string };
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
  const { body, identity, connection } = authenticated;
  const project = await findAccessibleProject(args.env.DB, body.orgProjectId, identity.userId);
  if (!project || project.connectionId !== connection.id) {
    return json({ error: 'This project is not available to you.' }, 403);
  }
  return { project, body, connection, identity };
}

const INVALID_REQUEST = 'Invalid workspace runtime project request.';

/** A JSON answer to the runtime. */
function json<Answer>(body: Answer, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
