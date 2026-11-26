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
  sharedOpWrites,
  sharedWorkspaceName,
  sharedWorkspaceRefsId,
  SHARED_WORKSPACE_HEADER,
  isSharedRead,
  SHARED_MERGE,
  SHARED_PREVIEW,
  sharedMergeRequestSchema,
  sharedPreviewRequestSchema,
  type SharedMergeAnswer,
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

/**
 * Why the person may not use `target` now, or null: any role fetches, and pushes too, where one who may only view the
 * project sets only their workspace's saved branches (`savedOnly`, from the role `onProject` is told).
 */
async function gitRefusal(
  env: GitProxyEnv,
  target: GitWorkspaceRepository,
  write: boolean,
  onProject: (project: { role: 'view' | 'edit'; deploysWith?: 'workers_builds' | 'cloudchef' }) => void = () =>
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
    return null;
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
    const other = OTHER_PROJECT_PATH.exec(new URL(request.url).pathname);
    if (other) {
      return fetchOtherProject(this.env, this.ctx.props.workspaceId, request, other[1]!, other[2]!);
    }
    const namespace = this.env.PROJECT_WORKSPACE;
    const workspace = namespace.get(namespace.idFromString(this.ctx.props.workspaceId));
    const repositories = new ProjectRepositories(this.env.ARTIFACTS);
    const workspaceId = this.ctx.props.workspaceId;
    const env = this.env;
    // A project CloudChef deploys itself builds each branch pushed to it: main to go live, another for a preview.
    let deployed: { orgProjectId: string } | null = null;
    // The project the workspace works on, once its access is checked.
    let teamProject: string | null = null;
    // Until the role is known, nothing but saved branches is pushed.
    let viewOnly = true;
    return handleGitProxyRequest(request, {
      repository: () => workspace.gitRepository(),
      author: () => commitAuthor(env),
      refusal: (target, write) =>
        gitRefusal(env, target, write, (project) => {
          viewOnly = project.role !== 'edit';
          teamProject = target.orgProjectId;
          deployed =
            project.deploysWith === 'cloudchef' && target.orgProjectId ? { orgProjectId: target.orgProjectId } : null;
        }),
      savedOnly: () => viewOnly,
      access: (repo, scope) => repositories.gitAccess(repo, scope),
      revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
      isAncestor: (repo, ancestor, commit) => repositories.isAncestor(repo, ancestor, commit),
      secretFilesPushed: (repo, base, commit) => repositories.secretFilesPushed(repo, base, commit),
      mainHead: (repo) => repositories.head(repo),
      workspaceRefs: workspaceRefsPrefix(workspaceId),
      recordPush: async (update) => {
        await workspace.recordGitPush(update);
        await recordAndPublishPush(env, this.ctx, teamProject, deployed, update);
      },
      recordBase: (base) => workspace.setGitBase(base),
      recordMainFetched: (commit) => workspace.setMainFetched(commit),
      fetch: (input, init) => fetch(input, init),
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
async function recordMainPush(env: GitProxyEnv, orgProjectId: string | null, update: RefUpdate): Promise<void> {
  const identity = runtimeConnectionIdentity(env);
  const report = mainPushReport(orgProjectId, update);
  if (!identity || !report) {
    return;
  }
  await reportMainPushed(env, identity, report)
    .catch(() => reportMainPushed(env, identity, report))
    .catch((error: Error) => console.warn({ event: 'main_push_not_recorded', orgProjectId, message: error.message }));
}

/**
 * A push that went in: told to the control plane, then built when CloudChef deploys the project. For a project
 * Workers Builds deploys, which builds the push by itself, the telling (which also cancels its builds of older
 * commits) goes on without the push waiting for it.
 */
async function recordAndPublishPush(
  env: GitProxyEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  orgProjectId: string | null,
  deployed: { orgProjectId: string } | null,
  update: RefUpdate,
): Promise<void> {
  if (!deployed) {
    ctx.waitUntil(recordMainPush(env, orgProjectId, update));
    return;
  }
  await recordMainPush(env, orgProjectId, update);
  await publishPush(env, deployed, update);
}

/** A branch pushed to a project CloudChef deploys itself is built: main to go live, another for a preview. */
async function publishPush(
  env: GitProxyEnv,
  project: { orgProjectId: string } | null,
  update: RefUpdate,
  /**
   * Whose push it is, when not this runtime's own person (whoever accepted a change someone offered); or `offered`,
   * for the offered change itself, which is held to what the project already uses whoever builds it.
   */
  from?: { pushedBy: string } | 'offered',
) {
  if (project && update.ref.startsWith('refs/heads/') && !/^0{40}$/.test(update.newOid)) {
    await env.PROJECT_BUILDER.get(env.PROJECT_BUILDER.idFromName(project.orgProjectId))
      .enqueue({
        orgProjectId: project.orgProjectId,
        branch: update.ref.slice('refs/heads/'.length),
        commit: update.newOid,
        ...(from === 'offered' ? { asCollaborator: true as const } : from ? { pushedBy: from.pushedBy } : {}),
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
    // A computer has no saved branches, so someone who may only view the project pushes nothing from one.
    refusal: async (repository, write) => {
      let mayEdit = false;
      const refused = await gitRefusal(env, repository, write, (project) => {
        mayEdit = project.role === 'edit';
      });
      return refused ?? (write && !mayEdit ? 'You can view this project but not change it.' : null);
    },
    access: (repo, scope) => repositories.gitAccess(repo, scope),
    revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
    isAncestor: (repo, ancestor, commit) => repositories.isAncestor(repo, ancestor, commit),
    secretFilesPushed: (repo, base, commit) => repositories.secretFilesPushed(repo, base, commit),
    mainHead: (repo) => repositories.head(repo),
    // Nothing is saved for a computer: no ref is one of its own.
    workspaceRefs: workspaceRefsPrefix(`command-line-${identity.userId}`),
    recordPush: (update) => recordAndPublishPush(env, ctx, orgProjectId, deployed, update),
    recordBase: async () => undefined,
    recordMainFetched: async () => undefined,
    fetch: (input, init) => fetch(input, init),
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
}

/**
 * `git.internal/projects/<id>.git`: another project's history, fetched (never pushed) through CloudChef, which checks
 * the person may read it, a public one among them (`runtime-shared`). The agent fetches a public copy a comment
 * thread suggests a change from this way (docs/proposals/comment-threads.md).
 */
const OTHER_PROJECT_PATH =
  /^\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.git\/(info\/refs|git-upload-pack)$/;

function fetchOtherProject(
  env: GitProxyEnv,
  workspaceId: string,
  request: Request,
  orgProjectId: string,
  rest: string,
): Promise<Response> {
  const identity = runtimeConnectionIdentity(env);
  const url = new URL(request.url);
  if (!identity) {
    return Promise.resolve(new Response('This workspace is not connected to CloudChef.', { status: 503 }));
  }
  if (rest === 'info/refs' && url.searchParams.get('service') !== 'git-upload-pack') {
    return Promise.resolve(
      new Response('Another project can only be fetched from here, not pushed to.', { status: 403 }),
    );
  }
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.set(SHARED_WORKSPACE_HEADER, workspaceId);
  return sharedProjectRequest(env, identity, orgProjectId, `git/${rest}`, {
    method: request.method === 'POST' ? 'POST' : 'GET',
    search: url.search,
    headers,
    body: request.method === 'POST' ? request.body : null,
  });
}

/**
 * A request about a project of this account that CloudChef checked and sent on (`/v1/shared/<project>/<op>`, with a
 * capability naming who it is for, the project and their role): one of the reads a workspace elsewhere makes of it, or
 * git fetching it, answered from this account's repository; or CloudChef's own `merge` and `preview` of a change
 * someone offered. Nothing is pushed this way.
 */
export async function handleSharedProjectRequest(
  request: Request,
  env: GitProxyEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  shared: { projectId: string; userId: string; role: 'view' | 'edit'; op: string },
): Promise<Response> {
  const identity = runtimeConnectionIdentity(env);
  if (!identity || (!isSharedOp(shared.op) && shared.op !== SHARED_MERGE && shared.op !== SHARED_PREVIEW)) {
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
  if (shared.op === SHARED_MERGE) {
    return mergeSuggestedChange(request, env, repositories, {
      repo: project.repo,
      orgProjectId: shared.projectId,
      mayEdit: shared.role === 'edit',
      deploysWith: project.deploysWith,
      acceptedBy: shared.userId,
    });
  }
  if (shared.op === SHARED_PREVIEW) {
    const asked = sharedPreviewRequestSchema.safeParse(await request.json().catch(() => null));
    if (request.method !== 'POST' || !asked.success) {
      return new Response('Name the commit and its branch.', { status: 400 });
    }
    const { branch, commit } = asked.data;
    const kept = await repositories.setBranch(project.repo, branch, commit);
    if (kept && commit) {
      await publishPush(
        env,
        project.deploysWith === 'cloudchef' ? { orgProjectId: shared.projectId } : null,
        { ref: `refs/heads/${branch}`, oldOid: '0'.repeat(40), newOid: commit },
        // Its code is whoever offered it's, not the person whose reading of the thread built the preview.
        'offered',
      );
    }
    return Response.json({ kept }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!isSharedOp(shared.op)) {
    return new Response('Not found.', { status: 404 });
  }
  if (isSharedRead(shared.op)) {
    return answerSharedRead(
      repositories,
      project.repo,
      shared.op,
      url.searchParams,
      (path) => !isExcludedProjectPath(path),
    );
  }
  if (sharedOpWrites(shared.op, url.searchParams)) {
    return new Response('This project can be fetched from here, not pushed to.', { status: 403 });
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
  const forwarded = new Request(
    `http://${GIT_PROXY_HOST}/project.git/${shared.op.slice('git/'.length)}${url.search}`,
    request,
  );
  return handleGitProxyRequest(forwarded, {
    repository: async () => target,
    author: () => commitAuthor(env),
    // CloudChef checked that they may read it before sending it on.
    refusal: async () => null,
    savedOnly: () => true,
    access: (repo, scope) => repositories.gitAccess(repo, scope),
    revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
    isAncestor: (repo, ancestor, commit) => repositories.isAncestor(repo, ancestor, commit),
    secretFilesPushed: (repo, base, commit) => repositories.secretFilesPushed(repo, base, commit),
    mainHead: (repo) => repositories.head(repo),
    workspaceRefs: workspaceRefsPrefix(sharedWorkspaceRefsId(shared.userId, workspace)),
    recordPush: async () => undefined,
    recordBase: async () => undefined,
    recordMainFetched: async () => undefined,
    fetch: (input, init) => fetch(input, init),
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
}

/**
 * CloudChef's `merge` for someone who may edit the project and accepted a suggested change: its commit, which this
 * repository already holds among a workspace's saved branches, is brought into main, and main is published as any
 * push of it is. Who accepted is recorded by CloudChef, which asked.
 */
async function mergeSuggestedChange(
  request: Request,
  env: GitProxyEnv,
  repositories: ProjectRepositories,
  project: {
    repo: string;
    orgProjectId: string;
    mayEdit: boolean;
    deploysWith?: 'workers_builds' | 'cloudchef';
    /** Who accepted the change: main is published as theirs. */
    acceptedBy: string;
  },
): Promise<Response> {
  if (request.method !== 'POST' || !project.mayEdit) {
    return new Response('Only someone who can change this project accepts a change to it.', { status: 403 });
  }
  const asked = sharedMergeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!asked.success) {
    return new Response('Name the commit to bring in.', { status: 400 });
  }
  const { branch, ...change } = asked.data;
  const result = await repositories.mergeIntoMain({ repo: project.repo, ...change });
  if (branch && ('merged' in result || 'already' in result)) {
    // Its preview's branch has served; a branch that can't be deleted now only stays listed.
    await repositories.setBranch(project.repo, branch, null).catch(() => undefined);
  }
  let answer: SharedMergeAnswer;
  if ('merged' in result) {
    answer = { status: 'merged', ...result.merged };
    await publishPush(
      env,
      project.deploysWith === 'cloudchef' ? { orgProjectId: project.orgProjectId } : null,
      { ref: 'refs/heads/main', oldOid: result.merged.from, newOid: result.merged.to },
      { pushedBy: project.acceptedBy },
    );
  } else if ('conflict' in result) {
    answer = { status: 'conflict', files: result.conflict };
  } else {
    answer = {
      status:
        'already' in result
          ? 'already'
          : 'missing' in result
            ? 'missing'
            : 'unrelated' in result
              ? 'unrelated'
              : 'secrets' in result
                ? 'secrets'
                : 'moved',
    };
  }
  return Response.json(answer, { headers: { 'Cache-Control': 'no-store' } });
}
