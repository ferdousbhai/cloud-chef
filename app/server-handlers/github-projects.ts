import { z } from 'zod';
import type { GitHubReturnMessage } from '~/lib/github-return-messages';
import { publicOrigin } from '~/lib/.server/public-origin';
import { getAuthSession } from '~/lib/.server/auth';
import { GitHubError } from '~/lib/.server/github/github-api';
import { PayloadTooLargeError } from '~/lib/bounded-body';
import { gitHubAppFromEnv, type GitHubApp } from '~/lib/.server/github/github-app';
import { readCookie, readJsonRequest, safeReturnTo } from '~/lib/.server/request-guards';
import { findMembership } from '~/lib/cloudflare/data/organization-access.server';
import { promotedDraftFiles, promotedWorkerName } from '~/lib/.server/github/promote-draft';
import {
  declineProductionRequest,
  findGitHubInstallation,
  claimProductionRequestForApproval,
  holdApprovalClaim,
  releaseApprovalClaim,
  linkProject,
  listAccessibleProjects,
  recordApprovedRequest,
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

const approveSchema = z.strictObject({
  orgId: z.string().uuid(),
  requestId: z.string().uuid(),
  repoName: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  private: z.boolean(),
});
const declineSchema = z.strictObject({
  orgId: z.string().uuid(),
  requestId: z.string().uuid(),
  note: z.string().trim().max(1_000),
});
const APPROVAL_COOKIE = 'cloudchef_github_approval';

const UNAVAILABLE = 'GitHub is not configured for this environment.';

/** Starts installing the App for an organization: an admin, recently signed in, is sent to GitHub. */
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
    await requireAdmin(env.DB, body.data.orgId, session.user.id);
    // No fresh CloudChef sign-in needed: GitHub has the admin install and authorize there, and the return
    // is accepted only for an installation they own.
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
  // The same return path finishes an admin's approval of a production request.
  const approvalState = readCookie(request, APPROVAL_COOKIE);
  if (approvalState && url.searchParams.get('state') === approvalState) {
    return completeProductionApproval({ request, env, app, state: approvalState });
  }
  const state = readCookie(request, STATE_COOKIE);
  // This is a browser coming back from GitHub: every outcome returns to Settings, which says what happened.
  const back = (message: GitHubReturnMessage) => redirect(settingsWithMessage(url.origin, message), request);
  // The state GitHub carries back must be the one this browser started with: a link carrying someone
  // else's installation and code can't finish an admin's half-finished connection.
  if (!state || url.searchParams.get('state') !== state) {
    // Changing the App's repositories on GitHub returns here too, with nothing to record.
    return back('returned');
  }
  const now = Date.now();
  const pending = await env.DB.prepare(
    `UPDATE github_install_states SET used_at = ?
     WHERE id = ? AND used_at IS NULL AND expires_at > ?
     RETURNING org_id, user_id`,
  )
    .bind(now, state, now)
    .first<{ org_id: string; user_id: string }>();
  const installationId = Number(url.searchParams.get('installation_id'));
  const code = url.searchParams.get('code');
  if (!pending || !app) {
    return back('install_expired');
  }
  if (!code && url.searchParams.get('setup_action') === 'update') {
    // Changing the repositories of the installation this team already has returns without a code:
    // there is nothing new to record, and nothing is recorded for any other installation.
    const current = await findGitHubInstallation(env.DB, pending.org_id);
    if (current && current.installationId === installationId) {
      return back('repositories_updated');
    }
  }
  if (!code || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return back('install_cancelled');
  }
  const session = await getAuthSession(env, request);
  const membership = session ? await findMembership(env.DB, pending.org_id, session.user.id) : null;
  if (session?.user.id !== pending.user_id || membership?.role !== 'admin' || membership.pausedAt !== null) {
    return back('install_other_admin');
  }
  try {
    const userToken = await app.userToken(code);
    const installation = (await app.userInstallations(userToken)).find((candidate) => candidate.id === installationId);
    // Seeing an installation isn't controlling it: anyone who can read one of an organization's repositories
    // sees its installations. It must be the admin's own account, or an organization they own.
    const controls =
      installation &&
      (installation.account.type === 'User'
        ? installation.account.login === (await app.userLogin(userToken))
        : await app.isOrganizationOwner(userToken, installation.account.login));
    if (!installation || !controls) {
      return back('install_not_owner');
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
 * An admin approving a member's production request: CloudChef creates the repository as them, so it
 * first sends them to GitHub to authorize that once. The return finishes it (`completeProductionApproval`).
 */
export function approveProductionRequestAction({
  request,
  env,
  app = gitHubAppFromEnv(env),
}: {
  request: Request;
  env: Env;
  app?: GitHubApp | null;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, approveSchema, 'Name the repository.');
    if ('response' in body) {
      return body.response;
    }
    await requireAdmin(env.DB, body.data.orgId, session.user.id);
    const installation = await findGitHubInstallation(env.DB, body.data.orgId);
    if (!app || !installation) {
      return Response.json({ error: app ? 'Connect GitHub first.' : UNAVAILABLE }, { status: 409 });
    }
    // Claimed now, not on the way back: the member can't swap the draft while the admin is on GitHub.
    // The claim and the state that finishes it are written together.
    const state = crypto.randomUUID();
    const now = await claimProductionRequestForApproval(env.DB, {
      orgId: body.data.orgId,
      requestId: body.data.requestId,
      adminId: session.user.id,
      approval: { state, repoName: body.data.repoName, private: body.data.private, ttlMs: STATE_TTL_MS },
    });
    if (now === null) {
      throw new OrganizationError(
        'That request was already decided, its requester left the team, or another admin is approving it.',
        409,
      );
    }
    const redirectUri = new URL(GITHUB_RETURN_PATH, publicOrigin(request)).toString();
    return Response.json(
      { authorizeUrl: app.authorizeUrl(state, redirectUri) },
      { status: 201, headers: { 'Set-Cookie': approvalCookie(state, STATE_TTL_MS / 1_000, request) } },
    );
  });
}

export function declineProductionRequestAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, declineSchema, 'Choose a request.');
    if ('response' in body) {
      return body.response;
    }
    await declineProductionRequest(env.DB, { ...body.data, actorId: session.user.id });
    return new Response(null, { status: 204 });
  });
}

/**
 * Back from GitHub with the admin's authorization: create the repository as them (in the account the
 * organization's App is installed on), give the App access to it, commit the draft as its first version,
 * and make it a project its requester may work on.
 */
async function completeProductionApproval(args: {
  request: Request;
  env: Env;
  app: GitHubApp | null;
  state: string;
}): Promise<Response> {
  const { request, env, app } = args;
  const url = new URL(request.url);
  // This is a browser coming back from GitHub: every outcome returns to Settings, which says what happened.
  const back = (message: GitHubReturnMessage | null, promoted?: string) => {
    const location = settingsWithMessage(url.origin, message);
    if (promoted) {
      location.searchParams.set('promoted', promoted);
    }
    return redirectClearing(location, request, APPROVAL_COOKIE);
  };
  const now = Date.now();
  const pending = await env.DB.prepare(
    `UPDATE github_approval_states SET used_at = ?
     WHERE id = ? AND used_at IS NULL AND expires_at > ?
     RETURNING request_id, user_id, repo_name, private, created_at`,
  )
    .bind(now, args.state, now)
    .first<{ request_id: string; user_id: string; repo_name: string; private: number; created_at: number }>();
  const code = url.searchParams.get('code');
  if (!app) {
    if (pending) {
      await releaseApprovalClaim(env.DB, pending.request_id, pending.created_at);
    }
    return back('github_unavailable');
  }
  if (!pending) {
    // Its claim on the request ends with it, so the request is open again at once.
    const expired = await env.DB.prepare(
      'SELECT request_id, created_at FROM github_approval_states WHERE id = ? AND used_at IS NULL',
    )
      .bind(args.state)
      .first<{ request_id: string; created_at: number }>();
    if (expired) {
      await releaseApprovalClaim(env.DB, expired.request_id, expired.created_at);
    }
    return back('approval_expired');
  }
  if (!code) {
    await releaseApprovalClaim(env.DB, pending.request_id, pending.created_at);
    return back('approval_cancelled');
  }
  const owner = await env.DB.prepare('SELECT org_id FROM production_requests WHERE id = ?')
    .bind(pending.request_id)
    .first<{ org_id: string }>();
  const session = await getAuthSession(env, request);
  const membership = session && owner ? await findMembership(env.DB, owner.org_id, session.user.id) : null;
  if (!owner || session?.user.id !== pending.user_id || membership?.role !== 'admin' || membership.pausedAt !== null) {
    await releaseApprovalClaim(env.DB, pending.request_id, pending.created_at);
    return back('approval_other_admin');
  }
  const installation = await findGitHubInstallation(env.DB, owner.org_id);
  if (!installation) {
    await releaseApprovalClaim(env.DB, pending.request_id, pending.created_at);
    return back('github_disconnected');
  }
  // The draft as it was when the admin clicked Approve: the claim made then must still hold, and it keeps
  // any other admin from creating a second repository while this one is created.
  const productionRequest = await holdApprovalClaim(env.DB, {
    orgId: owner.org_id,
    requestId: pending.request_id,
    claimedAt: pending.created_at,
  });
  if (!productionRequest) {
    return back('approval_changed');
  }
  const fail = async (message: GitHubReturnMessage) => {
    await releaseApprovalClaim(env.DB, productionRequest.id, productionRequest.claimedAt);
    return back(message);
  };
  try {
    const userToken = await app.userToken(code);
    const login = await app.userLogin(userToken);
    if (installation.accountType === 'User' && login !== installation.accountLogin) {
      return await fail('approval_wrong_account');
    }
    const repoOwner = installation.accountType === 'Organization' ? installation.accountLogin : null;
    const fullName = `${installation.accountLogin}/${pending.repo_name}`;
    const created = await app
      .createRepository(userToken, {
        owner: repoOwner,
        name: pending.repo_name,
        private: pending.private === 1,
        description: productionRequest.title,
      })
      .catch((error: GitHubError | Error) => {
        if (error instanceof GitHubError && error.status === 422) {
          return null;
        }
        throw error;
      });
    // Taken already: an approval that created it and then couldn't reach it, retried after the admin gave
    // the App access. Such a repository holds only GitHub's first commit; any other is refused below.
    const repository = created ?? (await app.findRepository(userToken, fullName));
    if (!repository) {
      return await fail('repository_name_refused');
    }
    await app.addRepositoryToInstallation(userToken, installation.installationId, repository.id);
    const client = await app
      .repository(
        installation.installationId,
        { id: repository.id, fullName: repository.full_name },
        { contents: 'write' },
      )
      .catch(() => null);
    if (!client) {
      return await fail('repository_unreachable');
    }
    // The README commit GitHub makes for a new repository can take a moment to appear.
    let head: string | null = null;
    for (let attempt = 0; attempt < 5 && !head; attempt += 1) {
      head = await client.branchHead(repository.default_branch);
      if (!head) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    if (!head) {
      return await fail('repository_not_ready');
    }
    if (!created && (await client.commitCount(repository.default_branch)) > 1) {
      return await fail('repository_name_taken');
    }
    await client.commit({
      branch: repository.default_branch,
      parent: head,
      baseTree: await client.commitTree(head),
      message: `${productionRequest.title}, from CloudChef`,
      changes: await promotedDraftFiles(productionRequest.snapshot, promotedWorkerName(pending.repo_name)),
      branchExists: true,
    });
    const projectId = await recordApprovedRequest(env.DB, {
      orgId: owner.org_id,
      actorId: pending.user_id,
      requestId: productionRequest.id,
      requestedBy: productionRequest.requestedBy,
      name: productionRequest.title,
      claimedAt: productionRequest.claimedAt,
      repository: { id: repository.id, fullName: repository.full_name, defaultBranch: repository.default_branch },
    });
    // Its requester left or was removed while the repository was being made: it isn't a project.
    return projectId === null ? back('approval_withdrawn') : back('approved', projectId);
  } catch (error) {
    if (error instanceof GitHubError) {
      console.error('GitHub refused part of a production approval', error.status);
      return await fail('approval_failed');
    }
    if (error instanceof PayloadTooLargeError) {
      return await fail('draft_too_large');
    }
    await releaseApprovalClaim(env.DB, productionRequest.id, productionRequest.claimedAt);
    throw error;
  }
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
      return Response.json({ error: 'Choose a team.' }, { status: 400 });
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
    const body = await readJsonRequest(request, orgSchema, 'Choose a team.');
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

/** Settings' organizations, saying what a return from GitHub did (as a code: Settings has the text). */
function settingsWithMessage(origin: string, message: GitHubReturnMessage | null): URL {
  const location = new URL('/settings', origin);
  if (message) {
    location.searchParams.set('github_message', message);
  }
  location.hash = 'organizations';
  return location;
}

/** Back to CloudChef, with the installation's browser state cleared. */
function redirect(location: URL, request: Request): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location.toString(), 'Cache-Control': 'no-store', 'Set-Cookie': stateCookie('', 0, request) },
  });
}

/** Back to CloudChef, with an approval's browser state cleared. */
function redirectClearing(location: URL, request: Request, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location.toString(),
      'Cache-Control': 'no-store',
      'Set-Cookie': cookieFor(cookie, '', 0, request),
    },
  });
}

function approvalCookie(value: string, maxAge: number, request: Request): string {
  return cookieFor(APPROVAL_COOKIE, value, maxAge, request);
}

function cookieFor(name: string, value: string, maxAge: number, request: Request): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=${GITHUB_RETURN_PATH}; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}

function stateCookie(value: string, maxAge: number, request: Request): string {
  return cookieFor(STATE_COOKIE, value, maxAge, request);
}
