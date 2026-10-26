import { WorkerEntrypoint } from 'cloudflare:workers';
import type { BuilderWorkspaceGitRepository } from '../../app/agents/builder-workspace-api';
import { runtimeConnectionIdentity } from '../../app/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import { handleGitProxyRequest } from '../../app/lib/.server/cloudflare/git-proxy';
import { commitAuthor, openProject, ProjectAccessError } from '../../app/lib/.server/cloudflare/linked-project-client';
import { ProjectRepositories } from '../../app/lib/.server/cloudflare/project-repository';
import type { ProjectWorkspace } from './index';
import { confirmUserWorkspaceAccess } from '../../app/lib/.server/cloudflare/user-workspace-cloudflare-credential';

type GitProxyEnv = Pick<
  Env,
  | 'ARTIFACTS'
  | 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT'
  | 'CONTROL_PLANE_SECRET'
  | 'CLOUDCHEF_USER_ID'
  | 'CLOUDFLARE_ACCOUNT_ID'
  | 'CLOUDCHEF_CONNECTION_ID'
  | 'CLOUDCHEF_CONNECTION_GENERATION'
  | 'CLOUDCHEF_USER_RUNTIME'
> & {
  PROJECT_WORKSPACE: DurableObjectNamespace<ProjectWorkspace>;
};

/** Why the person may not use `target` now: a team project needs its edit role to push, a view to fetch. */
async function gitRefusal(
  env: GitProxyEnv,
  target: BuilderWorkspaceGitRepository,
  write: boolean,
): Promise<string | null> {
  const identity = runtimeConnectionIdentity(env);
  if (!identity) {
    return 'This workspace is not connected to CloudChef.';
  }
  if (target.orgProjectId === null) {
    return (await confirmUserWorkspaceAccess(env, identity)) ? null : 'You no longer have access to this workspace.';
  }
  try {
    const project = await openProject(env, identity, target.orgProjectId);
    if (project.repo !== target.repo) {
      return 'This workspace no longer matches the project’s repository. Open the project again.';
    }
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
    return handleGitProxyRequest(request, {
      repository: () => workspace.gitRepository(),
      author: () => commitAuthor(this.env),
      refusal: (target, write) => gitRefusal(this.env, target, write),
      access: (repo, scope) => repositories.gitAccess(repo, scope),
      revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
      recordPush: (update) => workspace.recordGitPush(update),
      fetch: (input, init) => fetch(input, init),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }
}
