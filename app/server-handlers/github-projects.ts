import { z } from 'zod';
import { isRecentSignIn, reauthenticationRequired } from '~/lib/.server/account-reauthentication';
import { getAuthSession } from '~/lib/.server/auth';
import { GitHubError, gitHubAppFromEnv, type GitHubApp } from '~/lib/.server/github/github-app';
import { readCookie, readJsonRequest, safeReturnTo } from '~/lib/.server/request-guards';
import { findMembership } from '~/lib/cloudflare/data/organization-access.server';
import {
  findGitHubInstallation,
  linkProject,
  listAccessibleProjects,
  removeGitHubInstallation,
  saveGitHubInstallation,
  setProjectAccess,
  unlinkProject,
} from '~/lib/cloudflare/data/org-projects.server';
import { OrganizationError, requireAdmin } from '~/lib/cloudflare/data/organizations.server';
import { signedIn } from './organizations';

/**
 * GitHub for organizations: an admin installs CloudChef's GitHub App on the account holding the
 * organization's repositories, links repositories as projects and chooses who may work on each.
 */
export const GITHUB_RETURN_PATH = '/github/return';
const STATE_COOKIE = 'cloudchef_github_state';
const STATE_TTL_MS = 15 * 60_000;

const orgSchema = z.strictObject({ orgId: z.string().uuid() });
const startSchema = z.strictObject({ orgId: z.string().uuid(), callbackURL: z.string().max(2_048).optional() });
const linkSchema = z.strictObject({
  orgId: z.string().uuid(),
  repoId: z.number().int().positive(),
  name: z.string().trim().min(1).max(80),
});
const unlinkSchema = z.strictObject({ orgId: z.string().uuid(), projectId: z.string().uuid() });
const accessSchema = z.strictObject({
  orgId: z.string().uuid(),
  projectId: z.string().uuid(),
  userId: z.string().min(1).max(128),
  allowed: z.boolean(),
});

const UNAVAILABLE = 'GitHub is not configured for this environment.';

/** Starts installing the App for an organization: an admin, recently signed in, is sent to GitHub. */
export function startGitHubInstallAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const app = gitHubAppFromEnv(env);
    if (!app) {
      return Response.json({ error: UNAVAILABLE }, { status: 503 });
    }
    const body = await readJsonRequest(request, startSchema, 'Choose an organization.');
    if ('response' in body) {
      return body.response;
    }
    await requireAdmin(env.DB, body.data.orgId, session.user.id);
    // Pointing an organization at a GitHub account is as consequential as pointing it at a Cloudflare one.
    if (!isRecentSignIn(session)) {
      return reauthenticationRequired('Sign in again to confirm it is you, then connect GitHub.');
    }
    const state = crypto.randomUUID();
    const origin = new URL(request.url).origin;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO github_install_states (id, org_id, user_id, return_to, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        state,
        body.data.orgId,
        session.user.id,
        safeReturnTo(body.data.callbackURL, origin),
        now + STATE_TTL_MS,
        now,
      )
      .run();
    const installUrl = new URL(app.installUrl());
    installUrl.searchParams.set('state', state);
    return Response.json(
      { installUrl: installUrl.toString() },
      { status: 201, headers: { 'Set-Cookie': stateCookie(state, STATE_TTL_MS / 1_000, request) } },
    );
  });
}

/**
 * GitHub's return after installing, with the installation and an authorization code for the GitHub user
 * who installed it. The installation id in the URL proves nothing on its own: it is recorded only if
 * that user can reach it, for the organization and admin that started here in this browser.
 */
export async function completeGitHubInstallAction({
  request,
  env,
  app = gitHubAppFromEnv(env),
}: {
  request: Request;
  env: Env;
  app?: GitHubApp | null;
}): Promise<Response> {
  const url = new URL(request.url);
  const state = readCookie(request, STATE_COOKIE);
  const settings = new URL('/settings#organizations', url.origin);
  if (!state) {
    // Changing the App's repositories on GitHub returns here too, with nothing to record.
    return redirect(settings, request);
  }
  const now = Date.now();
  const pending = await env.DB.prepare(
    `UPDATE github_install_states SET used_at = ?
     WHERE id = ? AND used_at IS NULL AND expires_at > ?
     RETURNING org_id, user_id, return_to`,
  )
    .bind(now, state, now)
    .first<{ org_id: string; user_id: string; return_to: string }>();
  const installationId = Number(url.searchParams.get('installation_id'));
  const code = url.searchParams.get('code');
  if (!pending || !app || !code || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return redirect(settings, request);
  }
  const session = await getAuthSession(env, request);
  const membership = session ? await findMembership(env.DB, pending.org_id, session.user.id) : null;
  if (session?.user.id !== pending.user_id || membership?.role !== 'admin' || membership.pausedAt !== null) {
    return Response.json({ error: 'Only the admin who started connecting GitHub can finish it.' }, { status: 403 });
  }
  try {
    const userToken = await app.userToken(code);
    const installation = (await app.userInstallations(userToken)).find((candidate) => candidate.id === installationId);
    if (!installation) {
      return Response.json({ error: 'That GitHub installation is not yours.' }, { status: 403 });
    }
    await saveGitHubInstallation(env.DB, {
      orgId: pending.org_id,
      userId: pending.user_id,
      installation: {
        installationId,
        accountLogin: installation.account.login,
        accountType: installation.account.type,
      },
    });
  } catch (error) {
    if (error instanceof GitHubError) {
      return Response.json({ error: error.message }, { status: error.status >= 500 ? 502 : 400 });
    }
    throw error;
  }
  return redirect(new URL(safeReturnTo(pending.return_to, url.origin), url.origin), request);
}

/** The repositories the organization's installation reaches, for an admin choosing one to link. */
export function listGitHubRepositoriesAction({
  request,
  env,
  app = gitHubAppFromEnv(env),
}: {
  request: Request;
  env: Env;
  app?: GitHubApp | null;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const orgId = new URL(request.url).searchParams.get('orgId') ?? '';
    const parsed = orgSchema.safeParse({ orgId });
    if (!parsed.success) {
      return Response.json({ error: 'Choose an organization.' }, { status: 400 });
    }
    await requireAdmin(env.DB, orgId, session.user.id);
    const installation = await findGitHubInstallation(env.DB, orgId);
    if (!app || !installation) {
      return Response.json({ error: app ? 'Connect GitHub first.' : UNAVAILABLE }, { status: 409 });
    }
    const repositories = await withGitHub(() => app.installationRepositories(installation.installationId));
    if (repositories instanceof Response) {
      return repositories;
    }
    return Response.json(
      {
        repositories: repositories.map((repository) => ({
          id: repository.id,
          fullName: repository.full_name,
          defaultBranch: repository.default_branch,
          private: repository.private,
        })),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  });
}

/** Links a repository the installation reaches as one of the organization's projects. */
export function linkGitHubProjectAction({
  request,
  env,
  app = gitHubAppFromEnv(env),
}: {
  request: Request;
  env: Env;
  app?: GitHubApp | null;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, linkSchema, 'Choose a repository and name the project.');
    if ('response' in body) {
      return body.response;
    }
    await requireAdmin(env.DB, body.data.orgId, session.user.id);
    const installation = await findGitHubInstallation(env.DB, body.data.orgId);
    if (!app || !installation) {
      return Response.json({ error: app ? 'Connect GitHub first.' : UNAVAILABLE }, { status: 409 });
    }
    // Only a repository the organization's installation actually reaches can become its project.
    const repositories = await withGitHub(() => app.installationRepositories(installation.installationId));
    if (repositories instanceof Response) {
      return repositories;
    }
    const repository = repositories.find((candidate) => candidate.id === body.data.repoId);
    if (!repository) {
      throw new OrganizationError("CloudChef's GitHub App can't reach that repository.", 404);
    }
    const projectId = await linkProject(env.DB, {
      orgId: body.data.orgId,
      actorId: session.user.id,
      name: body.data.name,
      repository: { id: repository.id, fullName: repository.full_name, defaultBranch: repository.default_branch },
    });
    return Response.json({ projectId }, { status: 201 });
  });
}

export function unlinkGitHubProjectAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, unlinkSchema, 'Choose a project.');
    if ('response' in body) {
      return body.response;
    }
    await unlinkProject(env.DB, { ...body.data, actorId: session.user.id });
    return new Response(null, { status: 204 });
  });
}

export function setProjectAccessAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, accessSchema, 'Choose a project and a member.');
    if ('response' in body) {
      return body.response;
    }
    await setProjectAccess(env.DB, { ...body.data, actorId: session.user.id });
    return new Response(null, { status: 204 });
  });
}

export function disconnectGitHubAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, orgSchema, 'Choose an organization.');
    if ('response' in body) {
      return body.response;
    }
    await removeGitHubInstallation(env.DB, body.data.orgId, session.user.id);
    return new Response(null, { status: 204 });
  });
}

/** The projects this person may work on in the organization they are working in now. */
export function listMyProjectsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const context = session.context;
    const projects =
      context?.kind === 'organization' ? await listAccessibleProjects(env.DB, context.orgId, session.user.id) : [];
    return Response.json(
      {
        projects: projects.map(({ id, name, repoFullName, defaultBranch }) => ({
          id,
          name,
          repoFullName,
          defaultBranch,
        })),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  });
}

/** Runs a GitHub call, turning its failure into the response an admin sees. */
async function withGitHub<T>(call: () => Promise<T>): Promise<T | Response> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GitHubError) {
      return Response.json(
        {
          error: error.status === 404 ? 'GitHub no longer has that installation. Connect GitHub again.' : error.message,
        },
        { status: 502 },
      );
    }
    throw error;
  }
}

/** Back to CloudChef, with the installation's browser state cleared. */
function redirect(location: URL, request: Request): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location.toString(), 'Cache-Control': 'no-store', 'Set-Cookie': stateCookie('', 0, request) },
  });
}

function stateCookie(value: string, maxAge: number, request: Request): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${STATE_COOKIE}=${encodeURIComponent(value)}; Path=${GITHUB_RETURN_PATH}; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}
