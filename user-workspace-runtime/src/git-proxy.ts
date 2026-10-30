import { WorkerEntrypoint } from 'cloudflare:workers';
import { runtimeConnectionIdentity } from '../../app/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import {
  GIT_PROXY_HOST,
  type GitWorkspaceRepository,
  handleGitProxyRequest,
  mainPushReport,
  type RefUpdate,
  workspaceRefsPrefix,
} from '../../app/lib/.server/cloudflare/git-proxy';
import {
  commitAuthor,
  openProject,
  ProjectAccessError,
  reportMainPushed,
} from '../../app/lib/.server/cloudflare/linked-project-client';
import { ProjectRepositories } from '../../app/lib/.server/cloudflare/project-repository';
import {
  answerSharedRead,
  isSharedOp,
  sharedWorkspaceName,
  sharedWorkspaceRefsId,
  SHARED_WORKSPACE_HEADER,
  isSharedRead,
} from '../../app/lib/.server/cloudflare/shared-project';
import { sharedProjectRequest } from '../../app/lib/.server/cloudflare/user-workspace-cloudflare-credential';
import { isExcludedProjectPath } from '../../app/agents/linked-project-workspace';
import type { ProjectWorkspace } from './index';
import type { ProjectBuilder } from './project-builder';

type GitProxyEnv = Pick<
  Env,
  | 'ARTIFACTS'
  | 'DB'
  | 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT'
  | 'CONTROL_PLANE_SECRET'
  | 'CLOUDCHEF_USER_ID'
  | 'CLOUDFLARE_ACCOUNT_ID'
  | 'CLOUDCHEF_CONNECTION_ID'
  | 'CLOUDCHEF_CONNECTION_GENERATION'
  | 'CLOUDCHEF_USER_RUNTIME'
  | 'CLOUDCHEF_SHARED_ACCOUNT'
> & {
  PROJECT_WORKSPACE: DurableObjectNamespace<ProjectWorkspace>;
  PROJECT_BUILDER: DurableObjectNamespace<ProjectBuilder>;
};

/** Why the person may not use `target` now: a team project needs its edit role to push, a view to fetch. */
async function gitRefusal(
  env: GitProxyEnv,
  target: GitWorkspaceRepository,
  write: boolean,
  onProject: (project: { deploysWith?: 'workers_builds' | 'cloudchef'; inAnotherAccount?: boolean }) => void = () =>
    undefined,
): Promise<string | null> {
  const identity = runtimeConnectionIdentity(env);
  if (!identity) {
    return 'This workspace is not connected to CloudChef.';
  }
  if (target.orgProjectId === null) {
    return 'This workspace is not tied to a project. Open the project again.';
  }
  try {
    const project = await openProject(env, identity, target.orgProjectId);
    if (project.repo !== target.repo) {
      return 'This workspace no longer matches the project’s repository. Open the project again.';
    }
    onProject(project);
    return write && project.role !== 'edit' ? 'You can view this project but not change it.' : null;
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return error.message;
    }
    throw error;
  }
}

/** Minted for one workspace by its ProjectWorkspace, as the handler for git.internal in its container. */
export class GitProxy extends WorkerEntrypoint<GitProxyEnv, { workspaceId: string }> {
  override fetch(request: Request): Promise<Response> {
    const namespace = this.env.PROJECT_WORKSPACE;
    const workspace = namespace.get(namespace.idFromString(this.ctx.props.workspaceId));
    const repositories = new ProjectRepositories(this.env.ARTIFACTS);
    const workspaceId = this.ctx.props.workspaceId;
    const env = this.env;
    // A project CloudChef deploys itself builds each branch pushed to it: main to go live, another for a preview.
    let deployed: { orgProjectId: string } | null = null;
    // The project the workspace works on, once its access is checked.
    let teamProject: string | null = null;
    // Shared with this person from another account: its repository is reached only through CloudChef, whose runtime
    // in that account checks, records and publishes each push (`handleSharedProjectRequest`).
    let shared: { orgProjectId: string; userId: string } | null = null;
    return handleGitProxyRequest(request, {
      repository: () => workspace.gitRepository(),
      author: () => commitAuthor(env),
      refusal: (target, write) =>
        gitRefusal(env, target, write, (project) => {
          teamProject = target.orgProjectId;
          const identity = runtimeConnectionIdentity(env);
          shared =
            project.inAnotherAccount && target.orgProjectId && identity
              ? { orgProjectId: target.orgProjectId, userId: identity.userId }
              : null;
          deployed =
            !shared && project.deploysWith === 'cloudchef' && target.orgProjectId
              ? { orgProjectId: target.orgProjectId }
              : null;
        }),
      access: (repo, scope) =>
        shared ? Promise.resolve({ url: SHARED_REMOTE, secret: '', tokenId: '' }) : repositories.gitAccess(repo, scope),
      revoke: (repo, tokenId) => (shared ? Promise.resolve() : repositories.revokeToken(repo, tokenId)),
      isAncestor: (repo, ancestor, commit) => repositories.isAncestor(repo, ancestor, commit),
      secretFilesPushed: (repo, base, commit) => repositories.secretFilesPushed(repo, base, commit),
      mainHead: (repo) => repositories.head(repo),
      // A shared project's saved branches sit under this person's own folder in its repository.
      get workspaceRefs() {
        return workspaceRefsPrefix(shared ? sharedWorkspaceRefsId(shared.userId, workspaceId) : workspaceId);
      },
      recordPush: async (update) => {
        await workspace.recordGitPush(update);
        if (!shared) {
          await recordMainPush(env, teamProject, update);
          await publishPush(env, deployed, update);
        }
      },
      recordBase: (base) => workspace.setGitBase(base),
      recordMainFetched: (commit) => workspace.setMainFetched(commit),
      fetch: (input, init) =>
        shared ? sharedGitFetch(env, shared.orgProjectId, workspaceId, input, init) : fetch(input, init),
      forwarded: () => shared !== null,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }
}

/**
 * A push to a project's main (a team's or a person's own, whoever publishes it) is told to the control plane, which
 * keeps who pushed it, from and to which commit, and when (`listMainChanges`): nothing else of it reaches CloudChef,
 * as the push goes straight to the repository and Workers Builds reads main from there. It is told again once if the first telling fails; one that still can't be told is logged, and the push
 * stands.
 */
async function recordMainPush(
  env: GitProxyEnv,
  orgProjectId: string | null,
  update: RefUpdate,
  /** Someone the project is shared with from another account, whose push this runtime answered. */
  pushedBy?: string,
): Promise<void> {
  const identity = runtimeConnectionIdentity(env);
  const report = mainPushReport(orgProjectId, update);
  if (!identity || !report) {
    return;
  }
  const push = pushedBy ? { ...report, pushedBy } : report;
  await reportMainPushed(env, identity, push)
    .catch(() => reportMainPushed(env, identity, push))
    .catch((error: Error) => console.warn({ event: 'main_push_not_recorded', orgProjectId, message: error.message }));
}

/** A branch pushed to a project CloudChef deploys itself is built: main to go live, another for a preview. */
async function publishPush(env: GitProxyEnv, project: { orgProjectId: string } | null, update: RefUpdate) {
  if (project && update.ref.startsWith('refs/heads/') && !/^0{40}$/.test(update.newOid)) {
    await env.PROJECT_BUILDER.get(env.PROJECT_BUILDER.idFromName(project.orgProjectId))
      .enqueue({
        orgProjectId: project.orgProjectId,
        branch: update.ref.slice('refs/heads/'.length),
        commit: update.newOid,
      })
      .catch((error: Error) => console.warn({ event: 'push_deploy_not_started', message: error.message }));
  }
}

/**
 * git on the person's own computer, for a team or uploaded project, as `/v1/git/<project id>/…` (CloudChef checked
 * their command-line token and sent it on): the same checks as git in a workspace, and its pushes publish the
 * same way. It has no workspace, so no saved branches of one.
 */
export async function handleCommandLineGit(
  request: Request,
  env: GitProxyEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  orgProjectId: string,
  rest: string,
): Promise<Response> {
  const identity = runtimeConnectionIdentity(env);
  if (!identity) {
    return new Response('This workspace is not connected to CloudChef.', { status: 503 });
  }
  let project: Awaited<ReturnType<typeof openProject>>;
  try {
    project = await openProject(env, identity, orgProjectId);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return new Response(error.message, { status: 403 });
    }
    throw error;
  }
  if (!project.repo) {
    return new Response('This project has no repository yet. Open it in CloudChef once first.', { status: 409 });
  }
  const target = { repo: project.repo, orgProjectId, base: { branch: project.defaultBranch, commit: null } };
  const repositories = new ProjectRepositories(env.ARTIFACTS);
  const deployed = project.deploysWith === 'cloudchef' ? { orgProjectId } : null;
  const url = new URL(request.url);
  const forwarded = new Request(`http://${GIT_PROXY_HOST}/project.git/${rest}${url.search}`, request);
  return handleGitProxyRequest(forwarded, {
    repository: async () => target,
    author: () => commitAuthor(env),
    refusal: (repository, write) => gitRefusal(env, repository, write),
    access: (repo, scope) => repositories.gitAccess(repo, scope),
    revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
    isAncestor: (repo, ancestor, commit) => repositories.isAncestor(repo, ancestor, commit),
    secretFilesPushed: (repo, base, commit) => repositories.secretFilesPushed(repo, base, commit),
    mainHead: (repo) => repositories.head(repo),
    // Nothing is saved for a computer: no ref is one of its own.
    workspaceRefs: workspaceRefsPrefix(`command-line-${identity.userId}`),
    recordPush: async (update) => {
      await recordMainPush(env, orgProjectId, update);
      await publishPush(env, deployed, update);
    },
    recordBase: async () => undefined,
    recordMainFetched: async () => undefined,
    fetch: (input, init) => fetch(input, init),
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
}

/** Where git in a shared project's workspace is sent: not a repository, but the name `sharedGitFetch` answers to. */
const SHARED_REMOTE = 'http://shared.internal/git';

/**
 * git's request for a shared project's repository, sent to CloudChef (`runtime-shared/<project>/git/…`) with this
 * runtime's identity and the workspace whose saved branches it may see, instead of to Artifacts with a token.
 */
function sharedGitFetch(
  env: GitProxyEnv,
  orgProjectId: string,
  workspaceId: string,
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const identity = runtimeConnectionIdentity(env);
  const url = new URL(input instanceof Request ? input.url : input);
  const op = url.pathname.replace(/^\//, '');
  if (!identity || !url.href.startsWith(`${SHARED_REMOTE}/`)) {
    return Promise.resolve(new Response('This workspace is not connected to CloudChef.', { status: 503 }));
  }
  const headers = new Headers(init.headers);
  headers.delete('authorization');
  headers.set(SHARED_WORKSPACE_HEADER, workspaceId);
  return sharedProjectRequest(env, identity, orgProjectId, op, {
    method: init.method === 'POST' ? 'POST' : 'GET',
    search: url.search,
    headers,
    body: init.body ?? null,
  });
}

/**
 * A request of someone a project of this account is shared with, which CloudChef checked and sent on
 * (`/v1/shared/<project>/<op>`, with a capability naming them, the project and their role): one of the reads their
 * workspace makes, or git, answered from this account's repository with the same checks as git here. Their saved
 * branches sit under their own folder; a push of main is recorded as theirs and publishes as anyone's does.
 */
export async function handleSharedProjectRequest(
  request: Request,
  env: GitProxyEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  shared: { projectId: string; userId: string; role: 'view' | 'edit'; op: string },
): Promise<Response> {
  const identity = runtimeConnectionIdentity(env);
  if (!identity || !isSharedOp(shared.op)) {
    return new Response('Not found.', { status: 404 });
  }
  let project: Awaited<ReturnType<typeof openProject>>;
  try {
    project = await openProject(env, identity, shared.projectId);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return new Response(error.message, { status: 403 });
    }
    throw error;
  }
  if (!project.repo) {
    return new Response('This project has no code yet. Its owner opens it in CloudChef once first.', { status: 409 });
  }
  const repositories = new ProjectRepositories(env.ARTIFACTS);
  const url = new URL(request.url);
  if (isSharedRead(shared.op)) {
    return answerSharedRead(
      repositories,
      project.repo,
      shared.op,
      url.searchParams,
      (path) => !isExcludedProjectPath(path),
    );
  }
  const workspace = sharedWorkspaceName(request.headers.get(SHARED_WORKSPACE_HEADER));
  if (!workspace) {
    return new Response('Name the workspace this is for.', { status: 400 });
  }
  const target = {
    repo: project.repo,
    orgProjectId: shared.projectId,
    base: { branch: project.defaultBranch, commit: null },
  };
  const deployed = project.deploysWith === 'cloudchef' ? { orgProjectId: shared.projectId } : null;
  const forwarded = new Request(
    `http://${GIT_PROXY_HOST}/project.git/${shared.op.slice('git/'.length)}${url.search}`,
    request,
  );
  return handleGitProxyRequest(forwarded, {
    repository: async () => target,
    author: () => commitAuthor(env),
    // CloudChef checked their role before sending it on; it is checked again here from what it signed.
    refusal: async (_repository, write) =>
      write && shared.role !== 'edit' ? 'You can view this project but not change it.' : null,
    access: (repo, scope) => repositories.gitAccess(repo, scope),
    revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
    isAncestor: (repo, ancestor, commit) => repositories.isAncestor(repo, ancestor, commit),
    secretFilesPushed: (repo, base, commit) => repositories.secretFilesPushed(repo, base, commit),
    mainHead: (repo) => repositories.head(repo),
    workspaceRefs: workspaceRefsPrefix(sharedWorkspaceRefsId(shared.userId, workspace)),
    recordPush: async (update) => {
      await recordMainPush(env, shared.projectId, update, shared.userId);
      await publishPush(env, deployed, update);
    },
    recordBase: async () => undefined,
    recordMainFetched: async () => undefined,
    fetch: (input, init) => fetch(input, init),
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
}
