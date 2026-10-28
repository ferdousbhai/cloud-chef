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
  findReadableProject,
  listAccessibleProjects,
  listPublicProjects,
  setProjectVisibility,
  type ProjectVisibility,
} from '~/lib/cloudflare/data/org-projects.server';
import { findReadableApp, listAppsOf, listPublicApps, setAppVisibility } from '~/lib/cloudflare/data/apps.server';
import { getAuthSession } from '~/lib/.server/auth';
import { latestDeployments } from '~/lib/cloudflare/data/project-deployments.server';
import { mintRuntimeCapability } from '~/lib/cloudflare/runtime-capability';
import { usableWorkspaceRuntime } from './cloudflare-integration';
import { signedIn } from './signed-in';
import { usernameProblem } from '~/lib/usernames';

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

/**
 * The project a git path names, if `userId` may read it (one they may view or edit, or a public one), and the git
 * request's own part of the path.
 */
async function gitTarget(db: D1Database, pathname: string, userId: string) {
  const byId = GIT_ID_PATH.exec(pathname);
  if (byId) {
    return { target: await findReadable(db, { id: byId[1]! }, userId), rest: byId[2]! };
  }
  const byName = GIT_NAME_PATH.exec(pathname);
  return byName
    ? { target: await findReadable(db, { owner: byName[1]!, slug: byName[2]! }, userId), rest: byName[3]! }
    : null;
}

/** Whether a git request only reads: a fetch or clone, never a push. */
function readsOnly(rest: string, search: URLSearchParams): boolean {
  return rest === 'git-upload-pack' || (rest === 'info/refs' && search.get('service') === 'git-upload-pack');
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
  const found = await gitTarget(env.DB, new URL(request.url).pathname, userId);
  if (!found?.target) {
    return new Response('Repository not found.\n', { status: 404 });
  }
  const { target, rest } = found;
  // Someone who may only read it gets nothing else; a public one is read through its owner's runtime.
  if (!target.mayPush && !readsOnly(rest, new URL(request.url).searchParams)) {
    return new Response('You can read this project but not push to it. Make a copy to change it.\n', { status: 403 });
  }
  const runtime = await readerRuntime(request, env, userId, target);
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
  const forwardTo = new URL(
    target.kind === 'app' ? `/v1/git/app/${target.id}/${rest}` : `/v1/git/${target.id}/${rest}`,
    runtime.endpoint,
  );
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
      const [projects, apps] = await Promise.all([
        listAccessibleProjects(env.DB, context.connectionId, userId),
        listAppsOf(env.DB, userId, context.connectionId),
      ]);
      const account = context.kind === 'organization' ? context.orgName : 'Personal';
      // Apps made in a chat: their pushes are kept, and they go live from their workspace in CloudChef.
      const appRows = apps.map((app) => ({
        id: app.id,
        kind: 'app' as const,
        name: app.name,
        fullName: app.fullName,
        account,
        role: 'edit' as const,
        gitUrl: gitUrl(origin, app),
        visibility: app.visibility,
        defaultBranch: 'main',
        siteUrl: app.siteUrl,
        publishedBy: 'workspace' as const,
        lastPublish: null,
      }));
      const projectRows = await Promise.all(
        projects.map(async (project) => {
          const publish =
            project.deploysWith === 'cloudchef'
              ? ((await latestDeployments(env.DB, project.id)).find((row) => row.kind === 'production') ?? null)
              : null;
          return {
            id: project.id,
            kind: 'project' as const,
            name: project.name,
            fullName: project.fullName,
            account,
            role: project.role,
            gitUrl: gitUrl(origin, project),
            visibility: project.visibility,
            defaultBranch: project.defaultBranch,
            siteUrl: project.siteUrl,
            publishedBy: project.deploysWith === 'cloudchef' ? ('cloudchef' as const) : ('workers_builds' as const),
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
      return [...projectRows, ...appRows];
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
        project.visibility,
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
  // `empty=1`: no code yet; the person pushes their own history next (`cloudchef repo create --push`).
  const empty = url.searchParams.get('empty') === '1';
  const target = new URL(empty ? '/v1/projects/create-empty' : '/v1/projects/upload', runtime.endpoint);
  target.searchParams.set('name', name);
  const answer = await fetch(target, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtime.token}`,
      origin: publicOrigin(request),
      'content-type': request.headers.get('content-type') ?? 'application/zip',
    },
    body: empty ? null : request.body,
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

const usernameSchema = z.strictObject({ username: z.string().trim().toLowerCase().max(39) });

/** `POST /api/profile/username`: sets or changes the person's username, which their projects' addresses use. */
export function setUsernameAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, usernameSchema, 'Choose a username.');
    if ('response' in body) {
      return body.response;
    }
    const { username } = body.data;
    const problem = usernameProblem(username);
    if (problem) {
      return Response.json({ error: problem }, { status: 400 });
    }
    try {
      await env.DB.prepare('UPDATE "user" SET username = ? WHERE id = ?').bind(username, session.user.id).run();
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return Response.json({ error: `${username} is taken. Choose another.` }, { status: 409 });
      }
      throw error;
    }
    return Response.json({ username });
  });
}

/**
 * Something the person may read and copy, a project or an app, as git and copies need it: whose runtime reads it,
 * whether they read it only as a public one, whether they may push to it, and where its runtime serves it.
 */
type Readable = {
  kind: 'project' | 'app';
  id: string;
  name: string;
  fullName: string | null;
  connectionId: string;
  /** Its author or owner, whose runtime reads it for someone who has none in its account. */
  ownerId: string | null;
  /** Read only because it is public: nothing but reading goes to the owner's runtime for them. */
  readsAsPublic: boolean;
  mayPush: boolean;
};

/** The project, or else the app, `ref` names, if `userId` may read it. */
async function findReadable(
  db: D1Database,
  ref: { id: string } | { owner: string; slug: string },
  userId: string,
): Promise<Readable | null> {
  const project = await findReadableProject(db, ref, userId);
  if (project) {
    return {
      kind: 'project',
      id: project.id,
      name: project.name,
      fullName: project.fullName,
      connectionId: project.connectionId,
      ownerId: project.createdBy,
      readsAsPublic: project.role === 'public',
      mayPush: project.role === 'edit',
    };
  }
  const app = await findReadableApp(db, ref, userId);
  return app
    ? {
        kind: 'app',
        id: app.id,
        name: app.name,
        fullName: app.fullName,
        connectionId: app.connectionId,
        ownerId: app.userId,
        readsAsPublic: app.role === 'public',
        mayPush: app.role === 'owner',
      }
    : null;
}

/**
 * A runtime that may read `target` for `userId`: their own in its account, else (a public one, read by someone
 * with no runtime there) its owner's. It is asked only to read: the callers check that.
 */
async function readerRuntime(request: Request, env: Env, userId: string, target: Readable) {
  if (!target.readsAsPublic) {
    return runtimeFor(request, env, userId, target.connectionId);
  }
  if (!target.ownerId) {
    return { refusal: 'This can’t be read now: its author is no longer here.', status: 409 };
  }
  const owners = await runtimeFor(request, env, target.ownerId, target.connectionId);
  return 'refusal' in owners
    ? { refusal: 'This can’t be read until its author opens CloudChef again.', status: 503 }
    : owners;
}

const readAccessSchema = z.object({ url: z.string(), authorization: z.string(), branch: z.string() });

/**
 * A copy of `source` (which `userId` may read) in the account `connectionId` is: a project's copy is a project there,
 * an app's copy is an app of theirs. Answers the new one's id, its chat, and its full name.
 */
async function copyReadable(
  request: Request,
  env: Env,
  args: { userId: string; source: Readable; connectionId: string; name: string },
): Promise<{ projectId: string; initialId: string; fullName: string | null } | { refusal: string; status: number }> {
  const reader = await readerRuntime(request, env, args.userId, args.source);
  if ('refusal' in reader) {
    return reader;
  }
  const origin = publicOrigin(request);
  const app = args.source.kind === 'app';
  const readAnswer = await fetch(new URL(app ? '/v1/apps/read-access' : '/v1/projects/read-access', reader.endpoint), {
    method: 'POST',
    headers: { authorization: `Bearer ${reader.token}`, origin, 'content-type': 'application/json' },
    body: JSON.stringify(app ? { appId: args.source.id } : { orgProjectId: args.source.id }),
  });
  const access = readAccessSchema.safeParse(await readAnswer.json().catch(() => null));
  if (!readAnswer.ok || !access.success) {
    return { refusal: 'It couldn’t be read just now. Try again.', status: 502 };
  }
  const target = await runtimeFor(request, env, args.userId, args.connectionId);
  if ('refusal' in target) {
    return target;
  }
  const copyAnswer = await fetch(new URL(app ? '/v1/apps/copy' : '/v1/projects/copy', target.endpoint), {
    method: 'POST',
    headers: { authorization: `Bearer ${target.token}`, origin, 'content-type': 'application/json' },
    body: JSON.stringify(
      app
        ? { name: args.name, source: access.data }
        : { name: args.name, copiedFrom: args.source.id, source: access.data },
    ),
  });
  const answered: unknown = await copyAnswer.json().catch(() => null);
  const copied = z.object({ projectId: z.string().optional(), initialId: z.string() }).safeParse(answered);
  if (!copyAnswer.ok || !copied.success) {
    const failure = z.object({ error: z.string() }).safeParse(answered);
    return {
      refusal: failure.success ? failure.data.error : 'The copy could not be made. Try again.',
      status: copyAnswer.ok ? 502 : copyAnswer.status,
    };
  }
  // An app's id is its chat's.
  const projectId = copied.data.projectId ?? copied.data.initialId;
  const made = app ? null : await findAccessibleProject(env.DB, projectId, args.userId);
  return { projectId, initialId: copied.data.initialId, fullName: made?.fullName ?? null };
}

const browserCopySchema = z.strictObject({ projectId: z.string().uuid(), name: z.string().trim().max(80).optional() });

/** `POST /api/projects/copy`: a copy of a project or app the person may read, in the account they're working in now. */
export function copyProjectAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, browserCopySchema, 'Choose the project to copy.');
    if ('response' in body) {
      return body.response;
    }
    if (!session.context) {
      return Response.json({ error: 'Connect Cloudflare first, to have an account to copy it into.' }, { status: 409 });
    }
    const source = await findReadable(env.DB, { id: body.data.projectId }, session.user.id);
    if (!source) {
      return Response.json({ error: 'That project isn’t one you can copy.' }, { status: 404 });
    }
    const copied = await copyReadable(request, env, {
      userId: session.user.id,
      source,
      connectionId: session.context.connectionId,
      name: body.data.name || source.name,
    });
    return 'refusal' in copied
      ? Response.json({ error: copied.refusal }, { status: copied.status })
      : Response.json(copied, { status: 201 });
  });
}

const commandLineCopySchema = z.strictObject({
  project: z.string().uuid(),
  name: z.string().trim().max(80).optional(),
  account: z.string().max(120).optional(),
});

/** `POST /api/command-line/projects/copy`: `cloudchef repo fork`, into Personal or a named team's account. */
export async function commandLineCopyProjectAction({
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
  const body = await readJsonRequest(request, commandLineCopySchema, 'Name the project to copy.');
  if ('response' in body) {
    return body.response;
  }
  const source = await findReadable(env.DB, { id: body.data.project }, userId);
  if (!source) {
    return Response.json({ error: 'That project isn’t one you can copy.' }, { status: 404 });
  }
  const context = await accountNamed(env, userId, body.data.account ?? 'Personal');
  if ('error' in context) {
    return Response.json({ error: context.error }, { status: 404 });
  }
  const copied = await copyReadable(request, env, {
    userId,
    source,
    connectionId: context.connectionId,
    name: body.data.name || source.name,
  });
  if ('refusal' in copied) {
    return Response.json({ error: copied.refusal }, { status: copied.status });
  }
  return Response.json(
    {
      project: {
        id: copied.projectId,
        name: body.data.name || source.name,
        fullName: copied.fullName,
        gitUrl: gitUrl(publicOrigin(request), { id: copied.projectId, fullName: copied.fullName }),
      },
    },
    { status: 201 },
  );
}

/** The account the person calls `name`: Personal, or one of their teams by its name. */
async function accountNamed(env: Env, userId: string, name: string) {
  const contexts = await listWorkspaceContexts(env.DB, userId);
  const context = contexts.find((option) =>
    option.kind === 'organization' ? option.orgName === name : name === 'Personal',
  );
  if (!context) {
    const names = contexts.map((option) => (option.kind === 'organization' ? option.orgName : 'Personal'));
    return { error: `No account named ${name}. Yours: ${names.join(', ')}.` };
  }
  return context;
}

const visibilitySchema = z.strictObject({ projectId: z.string().uuid(), visibility: z.enum(['private', 'public']) });

/** A project its manager, or else an app its owner, makes public or private; false when neither is theirs. */
async function setVisibility(db: D1Database, userId: string, id: string, visibility: ProjectVisibility) {
  return (
    (await setProjectVisibility(db, { userId, projectId: id, visibility })) ||
    setAppVisibility(db, { userId, appId: id, visibility })
  );
}

/** `POST /api/projects/visibility`: the owner of a personal project, or a team's admin, makes it public or private. */
export function setVisibilityAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, visibilitySchema, 'Choose public or private.');
    if ('response' in body) {
      return body.response;
    }
    return (await setVisibility(env.DB, session.user.id, body.data.projectId, body.data.visibility))
      ? Response.json({ visibility: body.data.visibility })
      : Response.json({ error: 'Only its owner, or a team admin, can change who can see it.' }, { status: 403 });
  });
}

const commandLineVisibilitySchema = z.strictObject({
  project: z.string().uuid(),
  visibility: z.enum(['private', 'public']),
});

/** `POST /api/command-line/projects/visibility`: `cloudchef repo edit --visibility`. */
export async function commandLineVisibilityAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const userId = await tokenUser(request, env);
  if (!userId) {
    return Response.json({ error: 'Run cloudchef auth login.' }, { status: 401 });
  }
  const body = await readJsonRequest(request, commandLineVisibilitySchema, 'Choose public or private.');
  if ('response' in body) {
    return body.response;
  }
  return (await setVisibility(env.DB, userId, body.data.project, body.data.visibility))
    ? Response.json({ visibility: body.data.visibility })
    : Response.json({ error: 'Only its owner, or a team admin, can change who can see it.' }, { status: 403 });
}

/** `GET /api/explore`: public projects, newest first, for anyone signed in (a session, or a command-line token). */
export async function exploreAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const signedInUser = (await getAuthSession(env, request))?.user.id ?? (await tokenUser(request, env));
  if (!signedInUser) {
    return Response.json({ error: 'Sign in to explore projects.' }, { status: 401 });
  }
  const [publicProjects, publicApps] = await Promise.all([listPublicProjects(env.DB), listPublicApps(env.DB)]);
  const projects = [
    ...publicProjects.map((project) => ({
      id: project.id,
      kind: 'project' as const,
      name: project.name,
      fullName: project.fullName,
      owner: { username: project.fullName?.split('/')[0] ?? null, name: project.authorName ?? 'Someone' },
      siteUrl: project.siteUrl,
      siteFrameable: project.siteFrameable,
      createdAt: new Date(project.createdAt).toISOString(),
      copiedFrom: project.copiedFrom ? { fullName: project.copiedFromFullName } : null,
    })),
    ...publicApps.map((app) => ({
      id: app.id,
      kind: 'app' as const,
      name: app.name,
      fullName: app.fullName,
      owner: { username: app.fullName?.split('/')[0] ?? null, name: app.ownerName ?? 'Someone' },
      siteUrl: app.siteUrl,
      siteFrameable: null,
      createdAt: new Date(app.createdAt).toISOString(),
      copiedFrom: null,
    })),
  ].sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  if (new URL(request.url).searchParams.get('format') === 'tsv') {
    return tsv(
      projects.map((project) => [
        project.fullName ?? '-',
        project.name,
        project.owner.name,
        project.siteUrl ?? '-',
        project.id,
      ]),
    );
  }
  return Response.json({ projects }, { headers: { 'Cache-Control': 'no-store' } });
}

/** `GET /api/apps`: the person's apps in the account they're working in now, with their address and visibility. */
export function listMyAppsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const apps = session.context ? await listAppsOf(env.DB, session.user.id, session.context.connectionId) : [];
    return Response.json({
      apps: apps.map((app) => ({ id: app.id, fullName: app.fullName, visibility: app.visibility })),
    });
  });
}
