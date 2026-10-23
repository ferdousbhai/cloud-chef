import { runtimeConnectionIdentity } from '~/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import {
  ensureProjectRepository,
  openProject,
  ProjectAccessError,
  registerProjectImport,
} from '~/lib/.server/cloudflare/linked-project-client';
import {
  MAIN_BRANCH,
  nativeProjectRepo,
  ProjectRepositories,
  ProjectRepositoryError,
} from '~/lib/.server/cloudflare/project-repository';
import type { DataOperationResult, ProjectCloneAccess, ProjectCommit } from '~/lib/cloudflare/data-api';
import { ensureInitialChat, findChat, openLinkedChat } from './chat-repository.server';
import { cloneToken } from './clone-tokens.server';
import { DataNotFoundError, ProjectForbiddenError } from './errors';

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
      // The chat's current subchat is the app it shows.
      return {
        repo: nativeProjectRepo(chat.initial_id, chat.last_subchat_index),
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
    throw new DataNotFoundError('This project has no commits yet.');
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
    throw new DataNotFoundError('That commit is not in the project.');
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
  const registered = await registerProjectImport(env, identity, { url: args.url, name });
  await ensureProjectRepository(env, identity, repositories(env), {
    orgProjectId: registered.projectId,
    repo: null,
    importSource: registered.importSource ?? { url: args.url },
  });
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
      throw new DataNotFoundError('This project has no commits yet.');
    }
    const commit = await store.resolve(project.repo, ref);
    if (!commit) {
      throw new DataNotFoundError('That commit is not in the project.');
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

/** A data operation's repository failure in the words the data API answers with: missing, or not allowed. */
export async function withRepositoryErrors<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof ProjectRepositoryError && error.code === 'not_found') {
      throw new DataNotFoundError(error.message);
    }
    if (error instanceof ProjectRepositoryError && error.code === 'auth_required') {
      throw new ProjectForbiddenError(error.message);
    }
    throw error;
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
