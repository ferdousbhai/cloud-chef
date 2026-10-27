import { z } from 'zod';
import { findActiveCloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { findUserWorkspaceRuntime } from '~/lib/.server/cloudflare/user-workspace-runtime-repository';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { publicOrigin } from '~/lib/.server/public-origin';
import { readJsonRequest, withinAddressRateLimit } from '~/lib/.server/request-guards';
import {
  approveCommandLineLogin,
  commandLineTokenUser,
  createCommandLineToken,
  listCommandLineTokens,
  pendingCommandLineLogin,
  pollCommandLineLogin,
  revokeCommandLineToken,
  startCommandLineLogin,
  TooManyCommandLineTokensError,
} from '~/lib/cloudflare/data/command-line-tokens.server';
import { canUseConnection, listWorkspaceContexts } from '~/lib/cloudflare/data/organization-access.server';
import {
  findAccessibleProject,
  findAccessibleProjectByFullName,
  listAccessibleProjects,
} from '~/lib/cloudflare/data/org-projects.server';
import { latestDeployments } from '~/lib/cloudflare/data/project-deployments.server';
import { mintRuntimeCapability } from '~/lib/cloudflare/runtime-capability';
import { usableWorkspaceRuntime } from './cloudflare-integration';
import { signedIn } from './signed-in';

/**
 * Working on projects from the person's own computer, with their own tools: git clones and pushes the project's
 * repository through CloudChef (`/git/<project id>.git`), with a personal command-line token made in Settings, and
 * a push publishes as one from a workspace does. The token also reads the projects and how their publishes went.
 */

const GIT_SERVICE = '(info\\/refs|git-upload-pack|git-receive-pack)';
/** `/<username>/<project>.git/…`, as GitHub's; `/git/<project id>.git/…` stays for a project with no username yet. */
const GIT_NAME_PATH = new RegExp(`^\\/([a-z0-9-]{1,39})\\/([a-z0-9-]{1,64})\\.git\\/${GIT_SERVICE}$`);
const GIT_ID_PATH = new RegExp(`^\\/git\\/([0-9a-f-]{36})\\.git\\/${GIT_SERVICE}$`);
/** The request headers git's smart HTTP needs passed on; nothing else of the person's reaches their runtime. */
const GIT_HEADERS = ['accept', 'content-type', 'content-encoding', 'git-protocol', 'user-agent'];

const createSchema = z.strictObject({ label: z.string().trim().min(1).max(60) });
const revokeSchema = z.strictObject({ id: z.string().uuid() });

/** Whether `pathname` is one of a project's git addresses. */
export function isCommandLineGitPath(pathname: string): boolean {
  return GIT_ID_PATH.test(pathname) || GIT_NAME_PATH.test(pathname);
}

/** The project a git path names, if `userId` may view or edit it, and the git request's own part of the path. */
async function gitTarget(db: D1Database, pathname: string, userId: string) {
  const byId = GIT_ID_PATH.exec(pathname);
  if (byId) {
    return { project: await findAccessibleProject(db, byId[1]!, userId), rest: byId[2]! };
  }
  const byName = GIT_NAME_PATH.exec(pathname);
  return byName
    ? {
        project: await findAccessibleProjectByFullName(db, { owner: byName[1]!, slug: byName[2]! }, userId),
        rest: byName[3]!,
      }
    : null;
}

/** Where a project's git is: by its name when its author has a username, else by its id. */
function gitUrl(origin: string, project: { id: string; fullName: string | null }): string {
  return project.fullName ? `${origin}/${project.fullName}.git` : `${origin}/git/${project.id}.git`;
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
  const userId = await tokenUser(request, env);
  if (!userId) {
    return gitUnauthorized(
      'Run cloudchef auth login, or use a command-line token from CloudChef Settings as the password.',
    );
  }
  const target = await gitTarget(env.DB, new URL(request.url).pathname, userId);
  if (!target?.project) {
    return new Response('Repository not found.\n', { status: 404 });
  }
  const { project, rest } = target;
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
  const forwardTo = new URL(`/v1/git/${project.id}/${rest}`, runtime.endpoint);
  forwardTo.search = new URL(request.url).search;
  return fetch(forwardTo, {
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
            fullName: project.fullName,
            account: context.kind === 'organization' ? context.orgName : 'Personal',
            role: project.role,
            gitUrl: gitUrl(origin, project),
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
  const projects = accounts.flat();
  if (new URL(request.url).searchParams.get('format') === 'tsv') {
    return tsv(
      projects.map((project) => [
        project.name,
        project.account,
        project.role,
        project.lastPublish?.state ?? '-',
        project.siteUrl ?? '-',
        project.id,
        project.fullName ?? '-',
      ]),
    );
  }
  return Response.json({ projects }, { headers: { 'Cache-Control': 'no-store' } });
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

/** Rows for a shell to read: tab-separated, one per line, with tabs and line breaks in values made spaces. */
function tsv(rows: string[][]): Response {
  const body = rows.map((row) => row.map((value) => value.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
  return new Response(body ? `${body}\n` : '', {
    headers: { 'Content-Type': 'text/tab-separated-values; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const loginStartSchema = z.strictObject({ label: z.string().trim().min(1).max(80) });
const loginPollSchema = z.strictObject({ deviceCode: z.string().min(20).max(100) });
const loginApproveSchema = z.strictObject({ userCode: z.string().min(8).max(20) });
/** How often the command line asks whether its sign-in was approved. */
const LOGIN_POLL_SECONDS = 5;

/** `POST /api/command-line/login`: the command line starts signing in; the person approves it in the browser. */
export async function commandLineLoginAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!(await withinAddressRateLimit(env.CLOUDFLARE_OAUTH_START_RATE_LIMITER, request))) {
    return Response.json({ error: 'Too many sign-ins. Try again in a minute.' }, { status: 429 });
  }
  const body = await readJsonRequest(request, loginStartSchema, 'Name what is signing in.');
  if ('response' in body) {
    return body.response;
  }
  const started = await startCommandLineLogin(env.DB, body.data.label);
  const verificationUri = `${publicOrigin(request)}/login/device`;
  return Response.json(
    {
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(started.userCode)}`,
      interval: LOGIN_POLL_SECONDS,
      expiresIn: Math.round((started.expiresAt - Date.now()) / 1_000),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** `POST /api/command-line/login/poll`: the token, once the person approved; 428 while they haven't yet. */
export async function commandLineLoginPollAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const body = await readJsonRequest(request, loginPollSchema, 'Send the sign-in’s device code.');
  if ('response' in body) {
    return body.response;
  }
  const polled = await pollCommandLineLogin(env.DB, body.data.deviceCode);
  if (polled === 'pending') {
    return Response.json({ error: 'authorization_pending' }, { status: 428, headers: { 'Cache-Control': 'no-store' } });
  }
  if (polled === 'expired') {
    return Response.json({ error: 'This sign-in expired. Run cloudchef auth login again.' }, { status: 410 });
  }
  const user = await env.DB.prepare('SELECT email FROM "user" WHERE id = ?')
    .bind(polled.userId)
    .first<{ email: string }>();
  return Response.json(
    { token: polled.token, user: { email: user?.email ?? '' } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** `GET /api/command-line/login/describe?code=`: what the person is about to approve. */
export function commandLineLoginDescribeAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async () => {
    const pending = await pendingCommandLineLogin(env.DB, new URL(request.url).searchParams.get('code') ?? '');
    return pending
      ? Response.json(pending)
      : Response.json(
          { error: 'That code has expired or was already used. Run cloudchef auth login again.' },
          { status: 404 },
        );
  });
}

/** `POST /api/command-line/login/approve`: the signed-in person lets the command line with that code in. */
export function commandLineLoginApproveAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, loginApproveSchema, 'Enter the code the command line shows.');
    if ('response' in body) {
      return body.response;
    }
    return (await approveCommandLineLogin(env.DB, body.data.userCode, session.user.id))
      ? Response.json({ approved: true })
      : Response.json(
          { error: 'That code has expired or was already used. Run cloudchef auth login again.' },
          { status: 404 },
        );
  });
}

/** `GET /api/command-line/user`: who the token is for. */
export async function commandLineUserAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const userId = await tokenUser(request, env);
  if (!userId) {
    return Response.json({ error: 'Run cloudchef auth login.' }, { status: 401 });
  }
  const user = await env.DB.prepare('SELECT id, name, email FROM "user" WHERE id = ?')
    .bind(userId)
    .first<{ id: string; name: string; email: string }>();
  return Response.json(user, { headers: { 'Cache-Control': 'no-store' } });
}

/** `GET /api/command-line/runs?project=<id>`: the project's recent publishes, newest first. */
export async function commandLineRunsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const userId = await tokenUser(request, env);
  if (!userId) {
    return Response.json({ error: 'Run cloudchef auth login.' }, { status: 401 });
  }
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project') ?? '';
  const project = z.string().uuid().safeParse(projectId).success
    ? await findAccessibleProject(env.DB, projectId, userId)
    : null;
  if (!project) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  const runs = (await latestDeployments(env.DB, project.id)).map((run) => ({
    id: run.id,
    kind: run.kind,
    branch: run.branch,
    commit: run.commit,
    state: run.state,
    step: run.step,
    failureStage: run.failureStage,
    reason: run.reason,
    url: run.url,
    createdAt: new Date(run.createdAt).toISOString(),
    updatedAt: new Date(run.updatedAt).toISOString(),
  }));
  if (url.searchParams.get('format') === 'tsv') {
    return tsv(runs.map((run) => [run.state, run.kind, run.branch, run.commit.slice(0, 7), run.updatedAt, run.id]));
  }
  return Response.json({ runs }, { headers: { 'Cache-Control': 'no-store' } });
}

const rerunSchema = z.strictObject({ project: z.string().uuid(), deployment: z.string().uuid() });

/** `POST /api/command-line/runs/rerun`: a failed publish of the project, started again. */
export async function commandLineRerunAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const userId = await tokenUser(request, env);
  if (!userId) {
    return Response.json({ error: 'Run cloudchef auth login.' }, { status: 401 });
  }
  const body = await readJsonRequest(request, rerunSchema, 'Name the project and the publish.');
  if ('response' in body) {
    return body.response;
  }
  const project = await findAccessibleProject(env.DB, body.data.project, userId);
  if (!project) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  const runtime = await runtimeFor(request, env, userId, project.connectionId);
  if ('refusal' in runtime) {
    return Response.json({ error: runtime.refusal }, { status: runtime.status });
  }
  const answer = await fetch(new URL('/v1/projects/deploy', runtime.endpoint), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtime.token}`,
      origin: publicOrigin(request),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ orgProjectId: project.id, deploymentId: body.data.deployment }),
  });
  const result = z.object({ deploymentId: z.string() }).safeParse(await answer.json().catch(() => null));
  return answer.ok && result.success
    ? Response.json({ deployment: { id: result.data.deploymentId } }, { status: 202 })
    : Response.json(
        { error: 'The publish couldn’t start again. Try again.' },
        { status: answer.ok ? 502 : answer.status },
      );
}

/**
 * `POST /api/command-line/projects?name=<name>[&account=<account>]`, a ZIP as the body: a new project in the
 * person's own account (`Personal`, the default) or a team's they're an admin of, published like an upload.
 */
export async function commandLineCreateProjectAction({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const userId = await tokenUser(request, env);
  if (!userId) {
    return Response.json({ error: 'Run cloudchef auth login.' }, { status: 401 });
  }
  const url = new URL(request.url);
  const name = (url.searchParams.get('name') ?? '').trim().slice(0, 80);
  if (!name) {
    return Response.json({ error: 'Name the project.' }, { status: 400 });
  }
  const wanted = url.searchParams.get('account') ?? 'Personal';
  const contexts = await listWorkspaceContexts(env.DB, userId);
  const context = contexts.find((option) =>
    option.kind === 'organization' ? option.orgName === wanted : wanted === 'Personal',
  );
  if (!context) {
    const names = contexts.map((option) => (option.kind === 'organization' ? option.orgName : 'Personal'));
    return Response.json({ error: `No account named ${wanted}. Yours: ${names.join(', ')}.` }, { status: 404 });
  }
  const runtime = await runtimeFor(request, env, userId, context.connectionId);
  if ('refusal' in runtime) {
    return Response.json({ error: runtime.refusal }, { status: runtime.status });
  }
  const target = new URL('/v1/projects/upload', runtime.endpoint);
  target.searchParams.set('name', name);
  const answer = await fetch(target, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtime.token}`,
      origin: publicOrigin(request),
      'content-type': request.headers.get('content-type') ?? 'application/zip',
    },
    body: request.body,
  });
  const created = z.object({ projectId: z.string() }).safeParse(
    await answer
      .clone()
      .json()
      .catch(() => null),
  );
  if (!answer.ok || !created.success) {
    return new Response(answer.body, {
      status: answer.ok ? 502 : answer.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const project = await findAccessibleProject(env.DB, created.data.projectId, userId);
  const made = project ?? { id: created.data.projectId, name, fullName: null };
  return Response.json(
    {
      project: { id: made.id, name: made.name, fullName: made.fullName, gitUrl: gitUrl(publicOrigin(request), made) },
    },
    { status: 201 },
  );
}
