import { WorkerEntrypoint } from 'cloudflare:workers';
import type { BuilderWorkspaceGitRepository } from '../../app/agents/builder-workspace-api';
import { runtimeConnectionIdentity } from '../../app/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import { handleGitProxyRequest } from '../../app/lib/.server/cloudflare/git-proxy';
import { commitAuthor, openProject, ProjectAccessError } from '../../app/lib/.server/cloudflare/linked-project-client';
import { ProjectRepositories } from '../../app/lib/.server/cloudflare/project-repository';
import type { ProjectWorkspace } from './index';
import type { ProjectBuilder } from './project-builder';
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
    return (await confirmUserWorkspaceAccess(env, identity)) ? null : 'You no longer have access to this workspace.';
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
    return handleGitProxyRequest(request, {
      repository: () => workspace.gitRepository(),
      author: () => commitAuthor(this.env),
      refusal: (target, write) =>
        gitRefusal(this.env, target, write, (project) => {
          deployed =
            project.deploysWith === 'cloudchef' && target.orgProjectId ? { orgProjectId: target.orgProjectId } : null;
        }),
      access: (repo, scope) => repositories.gitAccess(repo, scope),
      revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
      recordPush: async (update) => {
        await workspace.recordGitPush(update);
        const project: { orgProjectId: string } | null = deployed;
        if (project && update.ref.startsWith('refs/heads/') && !/^0{40}$/.test(update.newOid)) {
          await this.env.PROJECT_BUILDER.get(this.env.PROJECT_BUILDER.idFromName(project.orgProjectId))
            .enqueue({
              orgProjectId: project.orgProjectId,
              branch: update.ref.slice('refs/heads/'.length),
              commit: update.newOid,
            })
            .catch((error: Error) => console.warn({ event: 'push_deploy_not_started', message: error.message }));
        }
      },
      recordBase: (base) => workspace.setGitBase(base),
      fetch: (input, init) => fetch(input, init),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }
}
