import { z } from 'zod';
import { runtimeConnectionIdentity } from '~/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import {
  abandonProjectImport,
  ensureProjectRepository,
  openProject,
  ProjectAccessError,
  ProjectRefusalError,
  ProjectUnavailableError,
  commitAuthor,
  registerProjectImport,
  registerUploadedProject,
} from '~/lib/.server/cloudflare/linked-project-client';
import {
  importedProjectRepo,
  MAIN_BRANCH,
  nativeProjectRepo,
  ProjectRepositories,
  ProjectRepositoryError,
} from '~/lib/.server/cloudflare/project-repository';
import type { DataOperationResult, ProjectCloneAccess, ProjectCommit } from '~/lib/cloudflare/data-api';
import { ensureInitialChat, findChat, openLinkedChat } from './chat-repository.server';
import { cloneToken } from './clone-tokens.server';
import { extractZip, ZipReadError } from '~/lib/.server/cloudflare/zip-extract';
import { PayloadTooLargeError, readBodyBytesWithLimit } from '~/lib/bounded-body';
import {
  BUILDER_WORKSPACE_MAX_FILE_BYTES,
  BUILDER_WORKSPACE_MAX_FILES,
} from '@cloudchef/user-workspace-runtime/protocol';
import { DataNotFoundError, ProjectForbiddenError, ProjectRepositoryFailureError } from './errors';
import { internalErrorResponse } from './http.server';
import { IMPORT_DIALOG_ACCESS_FIX } from '~/lib/github-return-messages';

/**
 * A project's history and its ways out, for the browser: its commits, a clone command, a ZIP of any
 * commit, and a fork into a new project. A CloudChef app (a chat's own repository, `p-<chat>`) is its
 * creator's alone; a team's project is whatever the control plane says this person may do with it, and
 * view is enough for all of these but a fork, which needs edit.
 */

/** Which project: a chat (a CloudChef app, or the team project it works on) or a team project by id. */
type ProjectTarget = { chatInitialId?: string; orgProjectId?: string };

type ResolvedProject = {
  repo: string | null;
  name: string;
  role: 'owner' | 'view' | 'edit';
  /** The team project it is; null for a CloudChef app. */
  orgProjectId: string | null;
};

const REVISION_TRAILER = /^CloudChef-Revision: ([0-9a-f]{64})$/m;

/** The repositories of the account this runtime deploys into; injectable for tests. */
type ProjectRepositoriesFactory = (env: Env) => ProjectRepositories;

const accountRepositories: ProjectRepositoriesFactory = (env) => new ProjectRepositories(env.ARTIFACTS);

async function resolveProject(env: Env, sessionId: string, target: ProjectTarget): Promise<ResolvedProject> {
  let orgProjectId = target.orgProjectId ?? null;
  if (target.chatInitialId) {
    const chat = await findChat(env.DB, { id: target.chatInitialId, sessionId });
    if (!chat) {
      throw new DataNotFoundError('Project not found');
    }
    const row = await env.DB.prepare('SELECT org_project_id FROM chats WHERE id = ?')
      .bind(chat.id)
      .first<{ org_project_id: string | null }>();
    orgProjectId = row?.org_project_id ?? null;
    if (!orgProjectId) {
      return {
        repo: nativeProjectRepo(chat.initial_id),
        name: chat.description?.trim() || 'project',
        role: 'owner',
        orgProjectId: null,
      };
    }
  }
  if (!orgProjectId) {
    throw new DataNotFoundError('Project not found');
  }
  const identity = runtimeConnectionIdentity(env);
  if (!identity) {
    throw new ProjectForbiddenError('This workspace is not connected to CloudChef.');
  }
  try {
    const project = await openProject(env, identity, orgProjectId);
    return { repo: project.repo, name: project.name, role: project.role, orgProjectId };
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      throw error.status === 404 ? new DataNotFoundError(error.message) : new ProjectForbiddenError(error.message);
    }
    throw error;
  }
}

/** The project's commits on main, newest first; none before its first. */
export async function projectHistory(
  env: Env,
  args: ProjectTarget & { sessionId: string; limit: number; offset: number },
  repositories: ProjectRepositoriesFactory = accountRepositories,
): Promise<ProjectCommit[]> {
  const project = await resolveProject(env, args.sessionId, args);
  if (!project.repo) {
    return [];
  }
  const commits = await repositories(env).log(project.repo, { limit: args.limit, offset: args.offset });
  return commits.map((commit) => {
    const entry: ProjectCommit = {
      hash: commit.hash,
      message: commit.message,
      author: commit.author,
      committedAt: commit.committedAt,
    };
    const revision = REVISION_TRAILER.exec(commit.message)?.[1];
    if (revision) {
      entry.revision = revision;
    }
    return entry;
  });
}

/** A `git clone` command for the project, with the person's read-only token, good for a year. */
export async function projectCloneAccess(
  env: Env,
  args: ProjectTarget & { sessionId: string },
  repositories: ProjectRepositoriesFactory = accountRepositories,
): Promise<ProjectCloneAccess> {
  const project = await resolveProject(env, args.sessionId, args);
  const store = repositories(env);
  if (!project.repo || !(await store.head(project.repo))) {
    throw new DataNotFoundError('This project has no saved versions yet.');
  }
  const access = await cloneToken(env.DB, store, {
    repo: project.repo,
    userId: args.sessionId,
    orgProjectId: project.orgProjectId,
  });
  const url = new URL(access.remote);
  url.username = 'x';
  url.password = access.token;
  return {
    remote: access.remote,
    token: access.token,
    expiresAt: access.expiresAt,
    command: `git clone ${url.toString()} ${folderName(project.name)}`,
  };
}

/**
 * A new CloudChef app copied from the project at `commit`, with its history up to there: its own repository
 * (`p-<new chat>`) and a new chat, whose workspace starts from that repository's main when it opens.
 */
export async function forkProject(
  env: Env,
  args: ProjectTarget & { sessionId: string; commit: string },
  repositories: ProjectRepositoriesFactory = accountRepositories,
): Promise<{ initialId: string }> {
  const project = await resolveProject(env, args.sessionId, args);
  if (project.role === 'view') {
    throw new ProjectForbiddenError('You can view this project but not copy it.');
  }
  const store = repositories(env);
  const head = project.repo ? await store.head(project.repo) : null;
  const commit = head && project.repo ? await store.resolve(project.repo, args.commit) : null;
  if (!project.repo || !head || !commit) {
    throw new DataNotFoundError('That version is not in the project.');
  }
  const initialId = crypto.randomUUID();
  await store.fork(project.repo, nativeProjectRepo(initialId), commit.hash === head ? {} : { commit: commit.hash });
  const chat = await ensureInitialChat(env.DB, { id: crypto.randomUUID(), creatorId: args.sessionId, initialId });
  // It holds the copied app already, so it is listed as one and never discarded as empty.
  await env.DB.prepare(`UPDATE chats SET description = ?, description_source = 'user', has_messages = 1 WHERE id = ?`)
    .bind(`${project.name} (fork)`.slice(0, 200), chat.id)
    .run();
  return { initialId };
}

/**
 * Imports a repository from elsewhere (GitHub) as one of this person's projects, in the account this
 * runtime deploys into: the control plane records the project (and, for a private repository, says how
 * to read it), its history becomes the project's repository, and a chat opens on it as a team project's does.
 */
export async function importProject(
  env: Env,
  args: { sessionId: string; url: string; name?: string },
  repositories: ProjectRepositoriesFactory = accountRepositories,
): Promise<DataOperationResult<'projects.import'>> {
  const identity = runtimeConnectionIdentity(env);
  if (!identity) {
    throw new ProjectForbiddenError('This workspace is not connected to CloudChef.');
  }
  const name =
    args.name ??
    new URL(args.url).pathname
      .split('/')
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.git$/, '') ??
    'project';
  let registered: Awaited<ReturnType<typeof registerProjectImport>>;
  try {
    registered = await registerProjectImport(env, identity, { url: args.url, name });
  } catch (error) {
    if (error instanceof ProjectRefusalError || error instanceof ProjectUnavailableError) {
      // The control plane answered, and keeps no project when it can't say how to read it.
      throw error;
    }
    // The answer never arrived, and the project may have been added before it broke off.
    throw new ProjectRepositoryFailureError(
      "CloudChef couldn't tell whether the project was added. If it's under Imported projects in the menu (Team projects, in a team), open it to finish copying " +
        'its code; if not, import it again.',
      503,
    );
  }
  try {
    await ensureProjectRepository(env, identity, repositories(env), {
      orgProjectId: registered.projectId,
      repo: null,
      importSource: registered.importSource,
    });
  } catch (error) {
    // The project is registered already, so importing the address again is refused. A copy that may pass is
    // finished by opening the project; one that never will is taken back, with what it left in Artifacts.
    const permanent =
      error instanceof ProjectRefusalError || (error instanceof ProjectRepositoryError && error.code !== 'unavailable');
    const reason =
      error instanceof ProjectRepositoryError ||
      error instanceof ProjectRefusalError ||
      error instanceof ProjectUnavailableError
        ? error.message.replace(/ Try again\.$/, '')
        : "Copying the project's code stopped partway.";
    if (!permanent) {
      throw new ProjectRepositoryFailureError(
        `${reason} The project was added: open it under Imported projects in the menu (Team projects, in a team) to finish copying it.`,
        503,
      );
    }
    // Asked twice: a passing failure of the first ask shouldn't leave a project whose code can't come.
    const abandoned =
      (await abandonProjectImport(env, identity, registered.projectId)) ||
      (await abandonProjectImport(env, identity, registered.projectId));
    if (abandoned) {
      await repositories(env)
        .deleteRepo(importedProjectRepo(registered.projectId))
        .catch(() => undefined);
      // A repository no longer public is imported again through GitHub; nothing is left to remove first.
      const noLongerPublic = noLongerPublicFailure(
        registered,
        error instanceof ProjectRepositoryError ? error.code : null,
      );
      throw new ProjectRepositoryFailureError(
        noLongerPublic
          ? "That repository wasn't found: it was removed, or it isn't public. To import a private repository, " +
              `${IMPORT_DIALOG_ACCESS_FIX} first. Nothing was added.`
          : `${reason} Nothing was added.`,
        409,
      );
    }
    // Not taken back: a repository that is no longer public can still be read once the App reaches it.
    throw new ProjectRepositoryFailureError(
      noLongerPublicFailure(registered, error instanceof ProjectRepositoryError ? error.code : null)
        ? `${reason} The project was added: once the App can read it, open it under Imported projects in the menu (Team projects, in a team).`
        : `${reason} The project was added, but its code can't be copied, and CloudChef couldn't remove it just now. Ask for help through Support if it stays.`,
      409,
    );
  }
  const { initialId } = await openLinkedChat(env.DB, {
    sessionId: args.sessionId,
    id: crypto.randomUUID(),
    orgProjectId: registered.projectId,
  });
  const result: DataOperationResult<'projects.import'> = {
    projectId: registered.projectId,
    initialId,
  };
  if (registered.workersBuildsFromGitHub !== undefined) {
    result.workersBuildsFromGitHub = registered.workersBuildsFromGitHub;
  }
  return result;
}

/**
 * The largest ZIP that may be uploaded, and what its files may add up to. The ZIP, its files and the commit
 * made of them are all held in the runtime's memory at once (128 MB), so these stay well below a workspace's
 * own limits.
 */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const MAX_UPLOADED_FILES_BYTES = 48 * 1024 * 1024;

/**
 * `POST /v1/projects/upload?name=<project name>`, the body a ZIP of a codebase: a new project of the account
 * this runtime deploys into (a team's, for one of its admins), whose first commit on main is the ZIP's files.
 * The runtime writes the repository (`t-<new id>`) first and only then asks the control plane to keep the
 * project, so a failure on either side leaves no project without code; a repository written for a project
 * that wasn't kept is deleted again.
 */
export async function userRuntimeProjectUploadAction(
  args: { request: Request; url: URL; env: Env; userId: string },
  repositories: ProjectRepositoriesFactory = accountRepositories,
): Promise<Response> {
  try {
    const name = args.url.searchParams.get('name')?.trim().slice(0, 80) || 'Uploaded project';
    const identity = runtimeConnectionIdentity(args.env);
    if (!identity) {
      throw new ProjectForbiddenError('This workspace is not connected to CloudChef.');
    }
    const files = await readUploadedFiles(args.request);
    const projectId = crypto.randomUUID();
    const repo = importedProjectRepo(projectId);
    const store = repositories(args.env);
    await withRepositoryErrors(
      (async () => {
        await store.ensureRepo(repo);
        let commit: string;
        try {
          const committed = await store.commitFiles({
            repo,
            branch: MAIN_BRANCH,
            parent: null,
            replaces: null,
            files,
            message: `Upload ${name}`,
            author: await commitAuthor(args.env),
          });
          if ('conflict' in committed) {
            throw new ProjectRepositoryError(
              'The new project was changed while it was being made. Try again.',
              'unavailable',
            );
          }
          commit = committed.commit;
        } catch (error) {
          await store.deleteRepo(repo).catch(() => undefined);
          throw error;
        }
        try {
          await registerUploadedProject(args.env, identity, { orgProjectId: projectId, name, repo });
          // Built and deployed by CloudChef from the start; a project that can't be is said to be code only. Not
          // starting it never fails the upload: opening the project starts it again.
          try {
            await args.env.PROJECT_BUILDER.get(args.env.PROJECT_BUILDER.idFromName(projectId)).enqueue({
              orgProjectId: projectId,
              branch: MAIN_BRANCH,
              commit,
            });
          } catch (error) {
            console.warn({ event: 'upload_deploy_not_started', message: String(error) });
          }
        } catch (error) {
          if (error instanceof ProjectRefusalError) {
            // Refused, so not kept as a project, and its code isn't kept either.
            await store.deleteRepo(repo).catch(() => undefined);
            throw error;
          }
          // No answer, or a failure after the project may have been kept: its code stays, so a project
          // that was kept is never left without it.
          throw new ProjectUnavailableError(
            "CloudChef couldn't confirm the project was added. Reload the projects page: if it's there, it's " +
              'ready; if not, upload the ZIP again.',
          );
        }
      })(),
    );
    const { initialId } = await openLinkedChat(args.env.DB, {
      sessionId: args.userId,
      id: crypto.randomUUID(),
      orgProjectId: projectId,
    });
    const result: DataOperationResult<'projects.import'> = { projectId, initialId };
    return Response.json(result, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return internalErrorResponse(error, 'The ZIP could not be uploaded. Try again.');
  }
}

/**
 * `POST /v1/projects/create-empty?name=<project name>`: a new project of this runtime's account with no commits yet,
 * for history pushed from the person's own computer (`cloudchef repo create --push`); that push publishes it.
 */
export async function userRuntimeProjectCreateEmptyAction(
  args: { url: URL; env: Env; userId: string },
  repositories: ProjectRepositoriesFactory = accountRepositories,
): Promise<Response> {
  try {
    const name = args.url.searchParams.get('name')?.trim().slice(0, 80) || 'New project';
    const identity = runtimeConnectionIdentity(args.env);
    if (!identity) {
      throw new ProjectForbiddenError('This workspace is not connected to CloudChef.');
    }
    const projectId = crypto.randomUUID();
    const repo = importedProjectRepo(projectId);
    const store = repositories(args.env);
    await withRepositoryErrors(store.ensureRepo(repo));
    await withRepositoryErrors(
      (async () => {
        try {
          await registerUploadedProject(args.env, identity, { orgProjectId: projectId, name, repo, pushed: true });
        } catch (error) {
          if (error instanceof ProjectRefusalError) {
            await store.deleteRepo(repo).catch(() => undefined);
            throw error;
          }
          throw new ProjectUnavailableError(
            "CloudChef couldn't confirm the project was made. Run cloudchef repo list: if it's there, it's ready.",
          );
        }
      })(),
    );
    const { initialId } = await openLinkedChat(args.env.DB, {
      sessionId: args.userId,
      id: crypto.randomUUID(),
      orgProjectId: projectId,
    });
    return Response.json({ projectId, initialId }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return internalErrorResponse(error, 'The project could not be made. Try again.');
  }
}

const readAccessSchema = z.strictObject({ orgProjectId: z.string().uuid() });

/**
 * `POST /v1/projects/read-access`: a short-lived read token for a project of this runtime's account, for git to
 * read its history with. CloudChef asks for it to make a copy of a project for someone who may read it, a public
 * one among them; the person this runtime is for may read it (the control plane checks that before it asks).
 */
export async function userRuntimeProjectReadAccessAction(
  args: { request: Request; env: Env },
  repositories: ProjectRepositoriesFactory = accountRepositories,
): Promise<Response> {
  const parsed = readAccessSchema.safeParse(await args.request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Name the project.' }, { status: 400 });
  }
  try {
    const identity = runtimeConnectionIdentity(args.env);
    if (!identity) {
      throw new ProjectForbiddenError('This workspace is not connected to CloudChef.');
    }
    const project = await openProject(args.env, identity, parsed.data.orgProjectId);
    if (!project.repo) {
      throw new DataNotFoundError('That project has no code yet.');
    }
    const access = await repositories(args.env).readAccess(project.repo);
    return Response.json(
      {
        url: access.remote,
        authorization: `Basic ${btoa(`x:${access.token}`)}`,
        branch: project.defaultBranch,
        expiresAt: Date.parse(access.expiresAt),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return internalErrorResponse(error, 'The project could not be read. Try again.');
  }
}

const appReadAccessSchema = z.strictObject({ appId: z.string().uuid() });

/**
 * `POST /v1/apps/read-access`: a short-lived read token for one of this person's apps (a chat's own repository),
 * for CloudChef to copy it or let someone read it while it is public.
 */
export async function userRuntimeAppReadAccessAction(
  args: { request: Request; env: Env; userId: string },
  repositories: ProjectRepositoriesFactory = accountRepositories,
): Promise<Response> {
  const parsed = appReadAccessSchema.safeParse(await args.request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Name the app.' }, { status: 400 });
  }
  try {
    // One of this person's own apps: a chat of theirs that isn't a team project's.
    const app = await args.env.DB.prepare(
      'SELECT 1 AS found FROM chats WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0 AND org_project_id IS NULL',
    )
      .bind(args.userId, parsed.data.appId)
      .first<{ found: number }>();
    if (!app) {
      throw new DataNotFoundError('That app is not here.');
    }
    const access = await repositories(args.env).readAccess(nativeProjectRepo(parsed.data.appId));
    return Response.json(
      {
        url: access.remote,
        authorization: `Basic ${btoa(`x:${access.token}`)}`,
        branch: MAIN_BRANCH,
        expiresAt: Date.parse(access.expiresAt),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return internalErrorResponse(error, 'The app could not be read. Try again.');
  }
}

const appCopySchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  source: z.strictObject({
    url: z.url({ protocol: /^https$/ }),
    authorization: z.string().min(1).max(4_096),
    branch: z.string().min(1).max(256),
  }),
});

/**
 * `POST /v1/apps/copy`: a new app of this person's (its own repository `p-<new chat>`, and a chat on it) whose
 * history is another app's, read from where CloudChef says with the token it got for it. Its workspace starts
 * from that history when it opens, as a fork's does.
 */
export async function userRuntimeAppCopyAction(
  args: { request: Request; env: Env; userId: string },
  repositories: ProjectRepositoriesFactory = accountRepositories,
): Promise<Response> {
  const parsed = appCopySchema.safeParse(await args.request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Say what to copy, and the new app’s name.' }, { status: 400 });
  }
  const { name, source } = parsed.data;
  try {
    const initialId = crypto.randomUUID();
    const repo = nativeProjectRepo(initialId);
    const store = repositories(args.env);
    try {
      await withRepositoryErrors(
        store.importFromUrl({ url: source.url, authorization: source.authorization, branch: source.branch, repo }),
      );
    } catch (error) {
      await store.deleteRepo(repo).catch(() => undefined);
      throw error;
    }
    const chat = await ensureInitialChat(args.env.DB, { id: crypto.randomUUID(), creatorId: args.userId, initialId });
    // It holds the copied app already, so it is listed as one and never discarded as empty.
    await args.env.DB.prepare(
      `UPDATE chats SET description = ?, description_source = 'user', has_messages = 1 WHERE id = ?`,
    )
      .bind(name, chat.id)
      .run();
    return Response.json({ initialId }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return internalErrorResponse(error, 'The copy could not be made. Try again.');
  }
}

const copySchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  copiedFrom: z.string().uuid(),
  source: z.strictObject({
    url: z.url({ protocol: /^https$/ }),
    authorization: z.string().min(1).max(4_096),
    branch: z.string().min(1).max(256),
  }),
});

/**
 * `POST /v1/projects/copy`: a new project of this runtime's account whose history is another project's, read from
 * where CloudChef says with the read token it got for it. Kept like an upload (the repository first, then the
 * project), and built and published from the start.
 */
export async function userRuntimeProjectCopyAction(
  args: { request: Request; env: Env; userId: string },
  repositories: ProjectRepositoriesFactory = accountRepositories,
): Promise<Response> {
  const parsed = copySchema.safeParse(await args.request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Say what to copy, and the new project’s name.' }, { status: 400 });
  }
  const { name, copiedFrom, source } = parsed.data;
  try {
    const identity = runtimeConnectionIdentity(args.env);
    if (!identity) {
      throw new ProjectForbiddenError('This workspace is not connected to CloudChef.');
    }
    const projectId = crypto.randomUUID();
    const repo = importedProjectRepo(projectId);
    const store = repositories(args.env);
    let commit: string;
    try {
      ({ commit } = await withRepositoryErrors(
        store.importFromUrl({ url: source.url, authorization: source.authorization, branch: source.branch, repo }),
      ));
    } catch (error) {
      await store.deleteRepo(repo).catch(() => undefined);
      throw error;
    }
    await withRepositoryErrors(
      (async () => {
        try {
          await registerUploadedProject(args.env, identity, { orgProjectId: projectId, name, repo, copiedFrom });
        } catch (error) {
          if (error instanceof ProjectRefusalError) {
            // Refused, so not kept as a project, and its copied code isn't kept either.
            await store.deleteRepo(repo).catch(() => undefined);
            throw error;
          }
          throw new ProjectUnavailableError(
            "CloudChef couldn't confirm the copy was made. Reload the projects page: if it's there, it's ready.",
          );
        }
      })(),
    );
    try {
      await args.env.PROJECT_BUILDER.get(args.env.PROJECT_BUILDER.idFromName(projectId)).enqueue({
        orgProjectId: projectId,
        branch: MAIN_BRANCH,
        commit,
      });
    } catch (error) {
      console.warn({ event: 'copy_deploy_not_started', message: String(error) });
    }
    const { initialId } = await openLinkedChat(args.env.DB, {
      sessionId: args.userId,
      id: crypto.randomUUID(),
      orgProjectId: projectId,
    });
    return Response.json({ projectId, initialId }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return internalErrorResponse(error, 'The copy could not be made. Try again.');
  }
}

/** The uploaded ZIP's files, within a workspace's limits; anything else is said to the person. */
async function readUploadedFiles(request: Request) {
  let archive: Uint8Array;
  try {
    archive = await readBodyBytesWithLimit(request, MAX_UPLOAD_BYTES, 'The ZIP');
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      throw new ProjectRepositoryFailureError(
        `The ZIP is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Leave out folders that can be made again, such as node_modules.`,
        413,
      );
    }
    throw error;
  }
  try {
    return await extractZip(archive, {
      maxFiles: BUILDER_WORKSPACE_MAX_FILES,
      maxFileBytes: BUILDER_WORKSPACE_MAX_FILE_BYTES,
      maxTotalBytes: MAX_UPLOADED_FILES_BYTES,
    });
  } catch (error) {
    if (error instanceof ZipReadError) {
      throw new ProjectRepositoryFailureError(error.message, error.code === 'too_large' ? 413 : 400);
    }
    throw error;
  }
}

/**
 * `GET /v1/projects/archive?chat=<id>|project=<id>&ref=<commit>`: the project at that commit (main's head
 * without one) as a ZIP, named `<project name>-<short commit>.zip`, streamed as it is read.
 */
export async function userRuntimeProjectArchiveAction(
  args: { url: URL; env: Env; userId: string },
  repositories: ProjectRepositoriesFactory = accountRepositories,
): Promise<Response> {
  const chat = args.url.searchParams.get('chat');
  const orgProject = args.url.searchParams.get('project');
  const ref = args.url.searchParams.get('ref') ?? MAIN_BRANCH;
  if ((chat === null) === (orgProject === null) || !/^([0-9a-f]{40}|main)$/.test(ref)) {
    return Response.json({ error: 'Name one project and a commit.' }, { status: 400 });
  }
  try {
    const project = await resolveProject(
      args.env,
      args.userId,
      chat ? { chatInitialId: chat } : { orgProjectId: orgProject ?? '' },
    );
    const store = repositories(args.env);
    if (!project.repo || !(await store.head(project.repo))) {
      throw new DataNotFoundError('This project has no saved versions yet.');
    }
    const commit = await store.resolve(project.repo, ref);
    if (!commit) {
      throw new DataNotFoundError('That version is not in the project.');
    }
    const folder = `${folderName(project.name)}-${commit.hash.slice(0, 7)}`;
    const { stream } = await store.archiveZip(project.repo, commit.hash, folder);
    return new Response(stream, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${folder}.zip"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof DataNotFoundError || (error instanceof ProjectRepositoryError && error.code === 'not_found')) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ProjectForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    console.warn('The project archive could not be made');
    return Response.json({ error: 'The project could not be downloaded. Try again.' }, { status: 500 });
  }
}

/** A copy refused because a repository imported as public isn't any more (or is gone). */
function noLongerPublicFailure(
  registered: { importSource: { authorization?: string | null } },
  code: ProjectRepositoryError['code'] | null,
): boolean {
  return !registered.importSource.authorization && (code === 'auth_required' || code === 'not_found');
}

/**
 * A data operation's repository failure in the words the data API answers with: missing, not allowed, too
 * large, or not possible just now (an import that broke off), each with its message for the person.
 */
export async function withRepositoryErrors<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof ProjectRefusalError) {
      throw new ProjectRepositoryFailureError(error.message, 409);
    }
    if (error instanceof ProjectUnavailableError) {
      throw new ProjectRepositoryFailureError(error.message, 503);
    }
    if (!(error instanceof ProjectRepositoryError)) {
      throw error;
    }
    switch (error.code) {
      case 'not_found':
        throw new DataNotFoundError(error.message);
      case 'auth_required':
        throw new ProjectForbiddenError(error.message);
      case 'too_large':
        throw new ProjectRepositoryFailureError(error.message, 413);
      case 'refused':
        throw new ProjectRepositoryFailureError(error.message, 409);
      default:
        throw new ProjectRepositoryFailureError(error.message, 503);
    }
  }
}

/** A project's name as a folder or file name: letters, digits and dashes. */
function folderName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

const deployRetrySchema = z.object({
  orgProjectId: z.string().uuid(),
  deploymentId: z.string().uuid(),
  toWantedWorker: z.literal(true).optional(),
});

/**
 * `POST /v1/projects/deploy`: a failed deploy of a project CloudChef deploys, started again; or, with
 * `toWantedWorker`, one that went to a derived Worker name, deployed again to the Worker its config names.
 */
export async function userRuntimeProjectDeployRetryAction(args: { request: Request; env: Env }): Promise<Response> {
  const parsed = deployRetrySchema.safeParse(await args.request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Name the project and the deploy.' }, { status: 400 });
  }
  try {
    const builder = args.env.PROJECT_BUILDER.get(args.env.PROJECT_BUILDER.idFromName(parsed.data.orgProjectId));
    return Response.json(await builder.retry(parsed.data), { status: 202, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return internalErrorResponse(error, "The deploy couldn't start again. Try again.");
  }
}

/** `GET /v1/projects/deploy-log?project=<id>&deployment=<id>`: the end of a deploy's log, as this workspace kept it. */
export async function userRuntimeProjectDeployLogAction(args: { url: URL; env: Env }): Promise<Response> {
  const parsed = deployRetrySchema.safeParse({
    orgProjectId: args.url.searchParams.get('project'),
    deploymentId: args.url.searchParams.get('deployment'),
  });
  if (!parsed.success) {
    return Response.json({ error: 'Name the project and the deploy.' }, { status: 400 });
  }
  const builder = args.env.PROJECT_BUILDER.get(args.env.PROJECT_BUILDER.idFromName(parsed.data.orgProjectId));
  const log = await builder.log(parsed.data.deploymentId);
  return log === null
    ? Response.json({ error: 'This workspace didn’t run that deploy, so it has no log of it.' }, { status: 409 })
    : new Response(log, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
