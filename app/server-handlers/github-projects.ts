import { GITHUB_UNREACHABLE, IMPORT_DIALOG_ACCESS_FIX } from '~/lib/github-return-messages';
import { z } from 'zod';
import type { GitHubReturnMessage } from '~/lib/github-return-messages';
import { getAuthSession } from '~/lib/.server/auth';
import { findActiveCloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { GitHubError } from '~/lib/.server/github/github-api';
import { gitHubAppFromEnv, type GitHubApp } from '~/lib/.server/github/github-app';
import { readCookie, readJsonRequest, safeReturnTo, serializeCookie } from '~/lib/.server/request-guards';
import { findMembership, isActiveAdmin } from '~/lib/cloudflare/data/organization-access.server';
import {
  findInstallationConnectedBy,
  listGitHubInstallations,
  removeGitHubInstallation,
  requireProjectScope,
  saveGitHubInstallation,
  type ProjectScope,
} from '~/lib/cloudflare/data/org-projects.server';
import { signedIn } from './signed-in';

/**
 * GitHub, for importing projects from private repositories: a team's admin, or a person for their own
 * projects, installs CloudChef's GitHub App on each GitHub account holding them (their own, and organizations
 * they own); imports read from all of them. Public repositories are
 * imported by their address, without it (`./projects.ts`).
 */
export const GITHUB_RETURN_PATH = '/github/return';
const STATE_COOKIE = 'cloudchef_github_state';
const STATE_TTL_MS = 15 * 60_000;

/** A team's projects with `orgId`, else the person's own. */
const scopeFields = { orgId: z.string().uuid().optional() };
const scopeSchema = z.strictObject(scopeFields);
const disconnectSchema = z.strictObject({ ...scopeFields, installationId: z.number().int().positive() });
const startSchema = z.strictObject({ ...scopeFields, callbackURL: z.string().max(2_048).optional() });

const UNAVAILABLE = 'GitHub is not configured for this environment.';

/**
 * Starts installing the App on a GitHub account for a team (by one of its admins) or for a person's own
 * projects. GitHub has them choose the account, so the same start connects another one.
 */
export function startGitHubInstallAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const app = gitHubAppFromEnv(env);
    if (!app) {
      return Response.json({ error: UNAVAILABLE }, { status: 503 });
    }
    const body = await readJsonRequest(request, startSchema, 'Choose a team.');
    if ('response' in body) {
      return body.response;
    }
    const scope = await requireProjectScope(env.DB, session.user.id, body.data.orgId);
    // No fresh CloudChef sign-in needed: GitHub has the person install and authorize there, and the return
    // is accepted only for an installation they own.
    const state = crypto.randomUUID();
    const origin = new URL(request.url).origin;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO github_install_states (id, connection_id, user_id, return_to, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        state,
        scope.connectionId,
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
      {
        status: 201,
        headers: { 'Set-Cookie': githubReturnCookie(state, STATE_TTL_MS / 1_000, request) },
      },
    );
  });
}

/**
 * GitHub's return after installing, with the installation and an authorization code for the GitHub user
 * who installed it. The installation id in the URL proves nothing on its own: it is recorded only if
 * that user owns the account it is installed on (their own, or an organization they own), for the
 * team or person that started here in this browser.
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
  // This is a browser coming back from GitHub. A connection made returns to where it started (an import dialog,
  // on the home page or in Settings, opens again with the new repositories); anything else, and an unexpected
  // failure, goes to Settings, which says why.
  const back = (message: GitHubReturnMessage, returnTo: string | null = null) =>
    redirect(returnLocation(url.origin, returnTo, message), request);
  try {
    return await completeInstallation({ request, env, app, back });
  } catch (error) {
    // Any failure GitHub's refusal isn't, such as D1's or the network's, still returns this browser to Settings.
    console.error(
      'A CloudChef installation failed',
      error instanceof Error ? `${error.name}: ${error.message}` : 'not an Error',
    );
    return back('install_failed');
  }
}

async function completeInstallation(args: {
  request: Request;
  env: Env;
  app: GitHubApp | null;
  back: (message: GitHubReturnMessage, returnTo?: string | null) => Response;
}): Promise<Response> {
  const { request, env, app } = args;
  let returnTo: string | null = null;
  const back = (message: GitHubReturnMessage) => args.back(message, returnTo);
  const url = new URL(request.url);
  const state = readCookie(request, STATE_COOKIE);
  // The state GitHub carries back must be the one this browser started with: a link carrying someone
  // else's installation and code can't finish a half-finished connection.
  if (!state || url.searchParams.get('state') !== state) {
    // Changing the App's repositories on GitHub returns here too, with nothing to record.
    return back('returned');
  }
  const now = Date.now();
  const pending = await env.DB.prepare(
    `UPDATE github_install_states SET used_at = ?
     WHERE id = ? AND used_at IS NULL AND expires_at > ?
     RETURNING connection_id, user_id, return_to`,
  )
    .bind(now, state, now)
    .first<{ connection_id: string; user_id: string; return_to: string }>();
  returnTo = pending?.return_to ?? null;
  const installationId = Number(url.searchParams.get('installation_id'));
  const code = url.searchParams.get('code');
  if (!pending || !app) {
    return back('install_expired');
  }
  if (!code && url.searchParams.get('setup_action') === 'update') {
    // Changing the repositories of an installation this connection already has returns without a code:
    // there is nothing new to record, and nothing is recorded for any other installation.
    const current = await listGitHubInstallations(env.DB, pending.connection_id);
    if (current.some((installation) => installation.installationId === installationId)) {
      return back('repositories_updated');
    }
    // GitHub has one installation per account: an account that has the App already comes back here, with no code
    // to prove who controls it again. A personal GitHub account its owner proved for another space may be added
    // here too, since who owns it can't change; an organization's owners can, so that needs a fresh install.
    if (Number.isSafeInteger(installationId) && installationId > 0) {
      const session = await getAuthSession(env, request);
      const scope =
        session?.user.id === pending.user_id
          ? await managedScope(env.DB, pending.connection_id, session.user.id)
          : null;
      const found = scope ? await findInstallationConnectedBy(env.DB, installationId, pending.user_id) : null;
      const proven = found?.accountType === 'User' ? found : null;
      if (!scope) {
        return back('install_other_admin');
      }
      if (!proven) {
        // Their own organization's installation, proven for another space: GitHub won't prove it again here.
        return back(found ? 'install_organization_elsewhere' : 'install_already_there');
      }
      await saveGitHubInstallation(env.DB, { scope, userId: pending.user_id, installation: proven });
      return back('connected');
    }
  }
  if (!code || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return back('install_cancelled');
  }
  const session = await getAuthSession(env, request);
  const scope =
    session?.user.id === pending.user_id ? await managedScope(env.DB, pending.connection_id, session.user.id) : null;
  if (!scope) {
    return back('install_other_admin');
  }
  try {
    const userToken = await app.userToken(code);
    const installation = await app.installation(installationId);
    // The App's installation on some account is not theirs: it must be on their own account, or on an
    // organization they own.
    const controls =
      installation &&
      (installation.account.type === 'User'
        ? installation.account.login === (await app.userLogin(userToken))
        : await app.isOrganizationOwner(userToken, installation.account.login));
    if (!installation || !controls) {
      return back('install_not_owner');
    }
    await saveGitHubInstallation(env.DB, {
      scope,
      userId: pending.user_id,
      installation: {
        installationId,
        accountLogin: installation.account.login,
        accountType: installation.account.type,
      },
    });
    return back('connected');
  } catch (error) {
    if (error instanceof GitHubError) {
      console.error('GitHub refused a CloudChef installation', error.status);
      return back('install_failed');
    }
    throw error;
  }
}

/**
 * The scope of the connection `connectionId`, while `userId` still manages it: its owner for a person's
 * own, an active admin for a team's. Null otherwise.
 */
async function managedScope(db: D1Database, connectionId: string, userId: string): Promise<ProjectScope | null> {
  const connection = await findActiveCloudflareConnection(db, connectionId);
  if (!connection) {
    return null;
  }
  if (connection.orgId === null) {
    return connection.userId === userId ? { connectionId, orgId: null } : null;
  }
  return isActiveAdmin(await findMembership(db, connection.orgId, userId))
    ? { connectionId, orgId: connection.orgId }
    : null;
}

/** The repositories the scope's installations reach, for choosing one to import. */
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
    const parsed = scopeSchema.safeParse({ orgId: new URL(request.url).searchParams.get('orgId') ?? undefined });
    if (!parsed.success) {
      return Response.json({ error: 'Choose a team.' }, { status: 400 });
    }
    const scope = await requireProjectScope(env.DB, session.user.id, parsed.data.orgId);
    const installed = await installedRepositories(env.DB, scope, app);
    if (installed instanceof Response) {
      return installed;
    }
    return Response.json(
      {
        // The GitHub accounts that couldn't be listed just now, so the picker can say some are missing.
        unreachable: installed.unreachable,
        repositories: installed.repositories.map((repository) => ({
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

export function disconnectGitHubAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, disconnectSchema, 'Choose a GitHub account.');
    if ('response' in body) {
      return body.response;
    }
    await removeGitHubInstallation(
      env.DB,
      await requireProjectScope(env.DB, session.user.id, body.data.orgId),
      body.data.installationId,
    );
    return new Response(null, { status: 204 });
  });
}

/**
 * The repositories the scope's installations reach, across every GitHub account it connected; the response
 * saying what's missing or what GitHub refused otherwise. An account that has since uninstalled the App is
 * passed over.
 */
export async function installedRepositories(db: D1Database, scope: ProjectScope, app: GitHubApp | null) {
  const installations = await listGitHubInstallations(db, scope.connectionId);
  if (!app || installations.length === 0) {
    return Response.json({ error: app ? 'Connect GitHub first.' : UNAVAILABLE }, { status: 409 });
  }
  // An account whose listing fails (uninstalled since, suspended, rate-limited) is passed over, so one account
  // can't block the others; only when every one fails is that the answer.
  const reached = await Promise.all(
    installations.map(async (installation) => {
      try {
        return await app.installationRepositories(installation.installationId);
      } catch (error) {
        if (error instanceof GitHubError) {
          return error;
        }
        throw error;
      }
    }),
  );
  const listed = reached.flatMap((result) => (result instanceof GitHubError ? [] : [result]));
  if (listed.length > 0) {
    return {
      repositories: listed.flat(),
      // Accounts that failed for a passing reason: not the App uninstalled (404) or suspended (a 403 that isn't a
      // rate limit) there.
      unreachable: installations.flatMap((installation, index) => {
        const result = reached[index];
        return result instanceof GitHubError && passingGitHubFailure(result) ? [installation.accountLogin] : [];
      }),
    };
  }
  return reached.every((result) => result instanceof GitHubError && !passingGitHubFailure(result))
    ? Response.json(
        { error: `CloudChef's GitHub App was removed or suspended on GitHub. To fix it, ${IMPORT_DIALOG_ACCESS_FIX}.` },
        { status: 502 },
      )
    : Response.json({ error: GITHUB_UNREACHABLE }, { status: 503 });
}

/** A GitHub failure that may pass on its own: anything but the App gone (404) or suspended (403, not a rate limit). */
function passingGitHubFailure(error: GitHubError): boolean {
  return error.status !== 404 && !(error.status === 403 && !error.rateLimited);
}

/**
 * Where a return from GitHub goes: after a connection is made, the page it started from on this origin; otherwise
 * Settings, the one page that shows what a return did.
 */
function returnLocation(origin: string, returnTo: string | null, message: GitHubReturnMessage | null): URL {
  if (returnTo && (message === 'connected' || message === 'repositories_updated')) {
    try {
      const location = new URL(returnTo, origin);
      // A bare "/" is the default when nothing was asked for: Settings says what happened, the builder wouldn't.
      if (location.origin === origin && !(location.pathname === '/' && location.search === '')) {
        if (message) {
          location.searchParams.set('github_message', message);
        }
        return location;
      }
    } catch {
      // Not an address: Settings, below.
    }
  }
  return settingsWithMessage(origin, message);
}

/** Settings, saying what a return from GitHub did (as a code: Settings has the text). */
function settingsWithMessage(origin: string, message: GitHubReturnMessage | null): URL {
  const location = new URL('/settings', origin);
  if (message) {
    location.searchParams.set('github_message', message);
  }
  location.hash = 'organizations';
  return location;
}

/** Back to CloudChef, with the browser state of the installation cleared. */
function redirect(location: URL, request: Request): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location.toString(),
      'Cache-Control': 'no-store',
      'Set-Cookie': githubReturnCookie('', 0, request),
    },
  });
}

function githubReturnCookie(value: string, maxAge: number, request: Request): string {
  return serializeCookie({ name: STATE_COOKIE, value, path: GITHUB_RETURN_PATH, maxAge, request });
}
