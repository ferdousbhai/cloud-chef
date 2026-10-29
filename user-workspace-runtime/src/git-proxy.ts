import { WorkerEntrypoint } from 'cloudflare:workers';
import type { BuilderWorkspaceGitRepository } from '../../app/agents/builder-workspace-api';
import { runtimeConnectionIdentity } from '../../app/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import {
  GIT_PROXY_HOST,
  handleGitProxyRequest,
  mainPushReport,
  type RefUpdate,
  workspaceRefsPrefix,
} from '../../app/lib/.server/cloudflare/git-proxy';
import { appGitRefusal } from '../../app/lib/.server/cloudflare/app-git-access';
import {
  commitAuthor,
  openProject,
  ProjectAccessError,
  reportMainPushed,
} from '../../app/lib/.server/cloudflare/linked-project-client';
import { nativeProjectRepo, ProjectRepositories } from '../../app/lib/.server/cloudflare/project-repository';
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
  target: BuilderWorkspaceGitRepository,
  write: boolean,
  onProject: (project: { deploysWith?: 'workers_builds' | 'cloudchef' }) => void = () => undefined,
): Promise<string | null> {
  const identity = runtimeConnectionIdentity(env);
  if (!identity) {
    return 'This workspace is not connected to CloudChef.';
  }
  if (target.orgProjectId === null) {
    return appGitRefusal(env, identity, target.repo);
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
    // A project CloudChef deploys itself builds each branch pushed to it: main to go live, another for a preview.
    let deployed: { orgProjectId: string } | null = null;
    // The team project the workspace works on, once its access is checked; null for the person's own app.
    let teamProject: string | null = null;
    return handleGitProxyRequest(request, {
      repository: () => workspace.gitRepository(),
      author: () => commitAuthor(this.env),
      refusal: (target, write) =>
        gitRefusal(this.env, target, write, (project) => {
          teamProject = target.orgProjectId;
          deployed =
            project.deploysWith === 'cloudchef' && target.orgProjectId ? { orgProjectId: target.orgProjectId } : null;
        }),
      access: (repo, scope) => repositories.gitAccess(repo, scope),
      revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
      isAncestor: (repo, ancestor, commit) => repositories.isAncestor(repo, ancestor, commit),
      secretFilesChanged: (repo, base, commit) => repositories.secretFilesChanged(repo, base, commit),
      mainHead: (repo) => repositories.head(repo),
      workspaceRefs: workspaceRefsPrefix(this.ctx.props.workspaceId),
      recordPush: async (update) => {
        await workspace.recordGitPush(update);
        await recordMainPush(this.env, teamProject, update);
        await publishPush(this.env, deployed, update);
      },
      recordBase: (base) => workspace.setGitBase(base),
      fetch: (input, init) => fetch(input, init),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }
}

/**
 * A push to a team project's main is told to the control plane, which keeps who pushed it and when for the team:
 * nothing else of it reaches CloudChef, as the push goes straight to the repository and Workers Builds reads main
 * from there. One that can't be told is logged; the push stands.
 */
async function recordMainPush(env: GitProxyEnv, orgProjectId: string | null, update: RefUpdate): Promise<void> {
  const identity = runtimeConnectionIdentity(env);
  const push = mainPushReport(orgProjectId, update);
  if (!identity || !push) {
    return;
  }
  await reportMainPushed(env, identity, push).catch((error: Error) =>
    console.warn({ event: 'main_push_not_recorded', orgProjectId, message: error.message }),
  );
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
    secretFilesChanged: (repo, base, commit) => repositories.secretFilesChanged(repo, base, commit),
    mainHead: (repo) => repositories.head(repo),
    // Nothing is saved for a computer: no ref is one of its own.
    workspaceRefs: workspaceRefsPrefix(`command-line-${identity.userId}`),
    recordPush: async (update) => {
      await recordMainPush(env, orgProjectId, update);
      await publishPush(env, deployed, update);
    },
    recordBase: async () => undefined,
    fetch: (input, init) => fetch(input, init),
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
}

/**
 * git on the person's own computer for one of their apps (a chat's own repository), as `/v1/git/app/<app id>/…`:
 * the same checks as git in a workspace. A push to it is kept; the app goes live from its workspace, as before.
 */
export async function handleCommandLineAppGit(
  request: Request,
  env: GitProxyEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  appId: string,
  rest: string,
): Promise<Response> {
  const identity = runtimeConnectionIdentity(env);
  if (!identity) {
    return new Response('This workspace is not connected to CloudChef.', { status: 503 });
  }
  const app = await env.DB.prepare(
    'SELECT 1 AS found FROM workspaces WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0 AND org_project_id IS NULL',
  )
    .bind(identity.userId, appId)
    .first<{ found: number }>();
  if (!app) {
    return new Response('Repository not found.', { status: 404 });
  }
  const target = { repo: nativeProjectRepo(appId), orgProjectId: null, base: { branch: 'main', commit: null } };
  const repositories = new ProjectRepositories(env.ARTIFACTS);
  const url = new URL(request.url);
  const forwarded = new Request(`http://${GIT_PROXY_HOST}/project.git/${rest}${url.search}`, request);
  return handleGitProxyRequest(forwarded, {
    repository: async () => target,
    author: () => commitAuthor(env),
    refusal: (repository, write) => gitRefusal(env, repository, write),
    access: (repo, scope) => repositories.gitAccess(repo, scope),
    revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
    isAncestor: (repo, ancestor, commit) => repositories.isAncestor(repo, ancestor, commit),
    secretFilesChanged: (repo, base, commit) => repositories.secretFilesChanged(repo, base, commit),
    mainHead: (repo) => repositories.head(repo),
    workspaceRefs: workspaceRefsPrefix(`command-line-${identity.userId}`),
    recordPush: async () => undefined,
    recordBase: async () => undefined,
    fetch: (input, init) => fetch(input, init),
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
}
