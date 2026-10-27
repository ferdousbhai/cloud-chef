import { z } from 'zod';
import { findActiveCloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { findUserWorkspaceRuntime } from '~/lib/.server/cloudflare/user-workspace-runtime-repository';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { publicOrigin } from '~/lib/.server/public-origin';
import { readJsonRequest } from '~/lib/.server/request-guards';
import {
  commandLineTokenUser,
  createCommandLineToken,
  listCommandLineTokens,
  revokeCommandLineToken,
  TooManyCommandLineTokensError,
} from '~/lib/cloudflare/data/command-line-tokens.server';
import { canUseConnection, listWorkspaceContexts } from '~/lib/cloudflare/data/organization-access.server';
import { findAccessibleProject, listAccessibleProjects } from '~/lib/cloudflare/data/org-projects.server';
import { latestDeployments } from '~/lib/cloudflare/data/project-deployments.server';
import { mintRuntimeCapability } from '~/lib/cloudflare/runtime-capability';
import { usableWorkspaceRuntime } from './cloudflare-integration';
import { signedIn } from './signed-in';

/**
 * Working on projects from the person's own computer, with their own tools: git clones and pushes the project's
 * repository through CloudChef (`/git/<project id>.git`), with a personal command-line token made in Settings, and
 * a push publishes as one from a workspace does. The token also reads the projects and how their publishes went.
 */

const GIT_PATH = /^\/git\/([0-9a-f-]{36})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
/** The request headers git's smart HTTP needs passed on; nothing else of the person's reaches their runtime. */
const GIT_HEADERS = ['accept', 'content-type', 'content-encoding', 'git-protocol', 'user-agent'];

const createSchema = z.strictObject({ label: z.string().trim().min(1).max(60) });
const revokeSchema = z.strictObject({ id: z.string().uuid() });

/** Whether `pathname` is one of a project's git addresses. */
export function isCommandLineGitPath(pathname: string): boolean {
  return GIT_PATH.test(pathname);
}

/** git asks again with the token when told who to ask for: Basic, as git's credential helpers store it. */
function gitUnauthorized(message: string): Response {
  return new Response(`${message}\n`, {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="CloudChef", charset="UTF-8"', 'Cache-Control': 'no-store' },
  });
}

/** The token a command-line request carries: git's Basic password (any user name), or a Bearer token. */
function requestToken(request: Request): string | null {
  const authorization = request.headers.get('authorization') ?? '';
  if (authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }
  if (authorization.startsWith('Basic ')) {
    try {
      const decoded = atob(authorization.slice('Basic '.length).trim());
      return decoded.slice(decoded.indexOf(':') + 1);
    } catch {
      return null;
    }
  }
  return null;
}

async function tokenUser(request: Request, env: Env): Promise<string | null> {
  const token = requestToken(request);
  return token ? commandLineTokenUser(env.DB, token) : null;
}

/**
 * The person's workspace runtime in the account `connectionId` is, and a capability for it: where a request of
 * theirs goes on to. Null when they may not use the account, or have no runtime in it yet.
 */
async function runtimeFor(
  request: Request,
  env: Env,
  userId: string,
  connectionId: string,
): Promise<{ endpoint: string; token: string } | { refusal: string; status: number }> {
  const connection = await findActiveCloudflareConnection(env.DB, connectionId);
  if (!connection || !(await canUseConnection(env.DB, userId, connection))) {
    return { refusal: 'You no longer have access to this project’s account.', status: 403 };
  }
  const usable = usableWorkspaceRuntime(await findUserWorkspaceRuntime(env.DB, userId, connection.id), connection);
  if (!usable || !env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
    return {
      refusal:
        'Your workspace for this project’s account isn’t ready. Open the project in CloudChef once, then try again.',
      status: 503,
    };
  }
  const secret = await deriveUserWorkspaceRuntimeSecret({
    encryptionKeyBase64: env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY,
    userId,
    accountId: connection.accountId,
    connectionGeneration: connection.generation,
    organizationConnectionId: connection.orgId ? connection.id : null,
  });
  const capability = await mintRuntimeCapability({ secret, subject: userId, origin: publicOrigin(request) });
  return { endpoint: usable.runtime.endpoint, token: capability.token };
}

/** `/git/<project id>.git/…`: git from the person's own computer, sent on to their runtime's git proxy. */
export async function commandLineGitAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const match = GIT_PATH.exec(new URL(request.url).pathname);
  if (!match) {
    return new Response('Not found.\n', { status: 404 });
  }
  const userId = await tokenUser(request, env);
  if (!userId) {
    return gitUnauthorized('Use a command-line token from CloudChef Settings as the password.');
  }
  const [, projectId, rest] = match;
  const project = await findAccessibleProject(env.DB, projectId!, userId);
  if (!project) {
    return new Response('Repository not found.\n', { status: 404 });
  }
  const runtime = await runtimeFor(request, env, userId, project.connectionId);
  if ('refusal' in runtime) {
    return new Response(`${runtime.refusal}\n`, { status: runtime.status });
  }
  const headers = new Headers({ authorization: `Bearer ${runtime.token}`, origin: publicOrigin(request) });
  for (const name of GIT_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  const target = new URL(`/v1/git/${projectId}/${rest}`, runtime.endpoint);
  target.search = new URL(request.url).search;
  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'POST' ? request.body : null,
    redirect: 'manual',
  });
}

/** `GET /api/command-line/projects`: the projects the token's owner may view or edit, in every account they use. */
export async function commandLineProjectsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const userId = await tokenUser(request, env);
  if (!userId) {
    return Response.json({ error: 'Use a command-line token from CloudChef Settings.' }, { status: 401 });
  }
  const origin = publicOrigin(request);
  const accounts = await Promise.all(
    (await listWorkspaceContexts(env.DB, userId)).map(async (context) => {
      const projects = await listAccessibleProjects(env.DB, context.connectionId, userId);
      return Promise.all(
        projects.map(async (project) => {
          const publish =
            project.deploysWith === 'cloudchef'
              ? ((await latestDeployments(env.DB, project.id)).find((row) => row.kind === 'production') ?? null)
              : null;
          return {
            id: project.id,
            name: project.name,
            account: context.kind === 'organization' ? context.orgName : 'Personal',
            role: project.role,
            gitUrl: `${origin}/git/${project.id}.git`,
            defaultBranch: project.defaultBranch,
            siteUrl: project.siteUrl,
            publishedBy: project.deploysWith === 'cloudchef' ? 'cloudchef' : 'workers_builds',
            lastPublish: publish && {
              id: publish.id,
              commit: publish.commit,
              state: publish.state,
              step: publish.step,
              reason: publish.reason,
              url: publish.url,
              updatedAt: publish.updatedAt,
            },
          };
        }),
      );
    }),
  );
  return Response.json({ projects: accounts.flat() }, { headers: { 'Cache-Control': 'no-store' } });
}

/** `GET /api/command-line/log?project=<id>&deployment=<id>`: what a publish of the project wrote, as its card shows. */
export async function commandLineLogAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const userId = await tokenUser(request, env);
  if (!userId) {
    return Response.json({ error: 'Use a command-line token from CloudChef Settings.' }, { status: 401 });
  }
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project') ?? '';
  const deploymentId = url.searchParams.get('deployment') ?? '';
  const project = z.string().uuid().safeParse(projectId).success
    ? await findAccessibleProject(env.DB, projectId, userId)
    : null;
  if (!project || !z.string().uuid().safeParse(deploymentId).success) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  const runtime = await runtimeFor(request, env, userId, project.connectionId);
  if ('refusal' in runtime) {
    return Response.json({ error: runtime.refusal }, { status: runtime.status });
  }
  const target = new URL('/v1/projects/deploy-log', runtime.endpoint);
  target.search = new URLSearchParams({ project: projectId, deployment: deploymentId }).toString();
  const answer = await fetch(target, {
    headers: { authorization: `Bearer ${runtime.token}`, origin: publicOrigin(request) },
  });
  return new Response(answer.body, {
    status: answer.status,
    headers: {
      'Content-Type': answer.headers.get('content-type') ?? 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** `GET /api/settings/command-line-tokens`: the person's tokens, never the tokens themselves. */
export function listCommandLineTokensAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) =>
    Response.json({ tokens: await listCommandLineTokens(env.DB, session.user.id) }),
  );
}

/** `POST /api/settings/command-line-tokens/create`: a new token, shown this once. */
export function createCommandLineTokenAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, createSchema, 'Give the token a name of up to 60 characters.');
    if ('response' in body) {
      return body.response;
    }
    try {
      const created = await createCommandLineToken(env.DB, session.user.id, body.data.label);
      return Response.json(created, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (error instanceof TooManyCommandLineTokensError) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
  });
}

/** `POST /api/settings/command-line-tokens/revoke`: ends a token at once. */
export function revokeCommandLineTokenAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, revokeSchema, 'Choose a token to remove.');
    if ('response' in body) {
      return body.response;
    }
    return (await revokeCommandLineToken(env.DB, session.user.id, body.data.id))
      ? Response.json({ revoked: true })
      : Response.json({ error: 'That token is already gone.' }, { status: 404 });
  });
}
