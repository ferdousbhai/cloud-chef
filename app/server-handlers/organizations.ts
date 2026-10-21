import { z } from 'zod';
import { getAuthSession, normalizeEmail, setSessionContext, type CloudflareAuthSession } from '~/lib/.server/auth';
import { hasSameOrigin, readJsonRequest } from '~/lib/.server/request-guards';
import { findCloudflareConnectionForOrganization } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import {
  acceptInvite,
  createInvite,
  createOrganization,
  deleteOrganizationRecords,
  describeInvite,
  listOrganizations,
  OrganizationError,
  prepareOrganizationDeletion,
  renameOrganization,
  requireAdmin,
  revokeInvite,
  revokeOrganizationConnection,
  updateMember,
} from '~/lib/cloudflare/data/organizations.server';
import {
  findGitHubInstallation,
  listAccessibleProjects,
  listOrgProjects,
  listOwnProductionRequests,
  listPendingProductionRequests,
} from '~/lib/cloudflare/data/org-projects.server';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import { workspaceRuntimeNames } from '~/workflows/user-workspace-runtime-provisioning';

/**
 * Organizations: an admin connects the organization's Cloudflare account and invites people by email;
 * they sign in (Google or an emailed link), accept, and build in that account. Every handler needs a
 * session and a same-origin request; admin-only ones check the role on each call.
 */
const ORGANIZATION_INVITE_PATH = '/join';
const SENDER = { email: 'noreply@cloudchef.build', name: 'CloudChef' };

const createSchema = z.strictObject({ name: z.string().trim().min(1).max(80) });
const inviteSchema = z.strictObject({
  orgId: z.string().uuid(),
  email: z.email().max(254),
  role: z.enum(['admin', 'member']).default('member'),
  /** The organization's GitHub projects they get on joining. */
  projectIds: z.array(z.string().uuid()).max(500).default([]),
  /** Whether they may build new apps of their own, not only work on the projects they're given. */
  draftsAllowed: z.boolean().default(true),
});
const acceptSchema = z.strictObject({ token: z.string().min(32).max(128) });
const contextSchema = z.strictObject({ connectionId: z.string().min(1).max(128) });
const memberSchema = z.strictObject({
  orgId: z.string().uuid(),
  userId: z.string().min(1).max(128),
  action: z.enum(['pause', 'resume', 'remove', 'make_admin', 'make_member', 'allow_drafts', 'disallow_drafts']),
  /** On removal, also delete their workspace (chats, project files) from the organization's account. */
  deleteWorkspace: z.boolean().default(true),
});
const revokeInviteSchema = z.strictObject({ orgId: z.string().uuid(), inviteId: z.string().uuid() });
const renameSchema = z.strictObject({ orgId: z.string().uuid(), name: z.string().trim().min(1).max(80) });
const deleteSchema = z.strictObject({ orgId: z.string().uuid() });

type Handler = (args: { request: Request; env: Env; session: CloudflareAuthSession }) => Promise<Response>;

/** Runs `handler` for a signed-in, same-origin request, turning organization errors into responses. */
export async function signedIn(request: Request, env: Env, handler: Handler): Promise<Response> {
  if (request.method !== 'GET' && !hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Sign in first.' }, { status: 401 });
  }
  try {
    return await handler({ request, env, session });
  } catch (error) {
    if (error instanceof OrganizationError) {
      return Response.json(error.code ? { error: error.message, code: error.code } : { error: error.message }, {
        status: error.status,
      });
    }
    throw error;
  }
}

export function listOrganizationsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const organizations = await listOrganizations(env.DB, session.user.id);
    // With each, its GitHub account and projects: all of them, with who may work on each, for an admin;
    // the ones they may work on for a member.
    const withProjects = await Promise.all(
      organizations.map(async (organization) => {
        const admin = organization.members !== null;
        const [github, projects, productionRequests, ownRequests] = await Promise.all([
          findGitHubInstallation(env.DB, organization.orgId),
          admin
            ? listOrgProjects(env.DB, organization.orgId)
            : listAccessibleProjects(env.DB, organization.orgId, session.user.id),
          admin ? listPendingProductionRequests(env.DB, organization.orgId) : null,
          listOwnProductionRequests(env.DB, organization.orgId, session.user.id),
        ]);
        return {
          ...organization,
          github: github ? { accountLogin: github.accountLogin, accountType: github.accountType } : null,
          projects: projects.map(({ id, name, repoFullName, defaultBranch, origin, memberIds }) => ({
            id,
            name,
            repoFullName,
            defaultBranch,
            origin,
            memberIds,
          })),
          productionRequests,
          ownRequests,
        };
      }),
    );
    return Response.json({ organizations: withProjects }, { headers: { 'Cache-Control': 'private, no-store' } });
  });
}

export function createOrganizationAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, createSchema, 'Give the team a name.');
    if ('response' in body) {
      return body.response;
    }
    const orgId = await createOrganization(env.DB, session.user.id, body.data.name);
    return Response.json({ orgId }, { status: 201 });
  });
}

/**
 * Invites someone by email: the link is emailed to them and returned, so the admin can also pass it
 * on themselves. Only the invited address can accept it.
 */
export function inviteToOrganizationAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, inviteSchema, 'Enter a valid email address.');
    if ('response' in body) {
      return body.response;
    }
    const { orgId, role, projectIds, draftsAllowed } = body.data;
    const email = normalizeEmail(body.data.email);
    const admin = await requireAdmin(env.DB, orgId, session.user.id);
    // Invites are email CloudChef sends with text an admin chose, so they're rate-limited per admin.
    const { success } = await env.SIGN_IN_RATE_LIMITER.limit({ key: `invite:${session.user.id}` });
    if (!success) {
      return Response.json({ error: 'Too many invites at once. Try again in a minute.' }, { status: 429 });
    }
    const { token, expiresAt } = await createInvite(env.DB, {
      orgId,
      email,
      role,
      invitedBy: session.user.id,
      projectIds,
      draftsAllowed,
    });
    const link = new URL(ORGANIZATION_INVITE_PATH, new URL(request.url).origin);
    link.searchParams.set('token', token);
    const emailed = await sendInvite(env, { to: email, orgName: admin.orgName, inviter: session.user.name, link });
    return Response.json({ inviteUrl: link.toString(), expiresAt, emailed }, { status: 201 });
  });
}

/**
 * What an invite link is for, so its page can greet the person by the organization and offer to sign
 * them in with the invited address. Needs no session: the link itself is the secret.
 */
export async function describeInviteAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const { success } = await env.SIGN_IN_RATE_LIMITER.limit({
    key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
  });
  if (!success) {
    return Response.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  const body = await readJsonRequest(request, acceptSchema, 'This invite link is not valid.');
  if ('response' in body) {
    return body.response;
  }
  try {
    const invite = await describeInvite(env.DB, body.data.token);
    return invite
      ? Response.json(invite, { headers: { 'Cache-Control': 'no-store' } })
      : Response.json({ error: 'This invite has been used or has expired. Ask for a new one.' }, { status: 410 });
  } catch (error) {
    if (error instanceof OrganizationError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }
}

export function acceptInviteAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, acceptSchema, 'This invite link is not valid.');
    if ('response' in body) {
      return body.response;
    }
    const { orgId } = await acceptInvite(env.DB, { token: body.data.token, userId: session.user.id });
    // Straight into the organization's account, once its admin has connected one; `switched` tells the
    // invite page whether the builder is ready to open there.
    const connection = await findCloudflareConnectionForOrganization(env.DB, orgId);
    const switched = connection?.status === 'active';
    if (switched) {
      await setSessionContext(env, request, connection.id);
    }
    return Response.json({ orgId, switched });
  });
}

/**
 * An admin pausing, resuming, removing, promoting or demoting a member, or a member leaving. Pausing
 * or removing takes effect at the person's next request: the credential broker and the workspace
 * session both ask about membership every time.
 */
export function updateMemberAction({
  request,
  env,
  deleteWorkspace = deleteMemberWorkspace,
}: {
  request: Request;
  env: Env;
  deleteWorkspace?: typeof deleteMemberWorkspace;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, memberSchema, 'Choose a member and what to do.');
    if ('response' in body) {
      return body.response;
    }
    const { orgId, userId, action } = body.data;
    await updateMember(env.DB, { orgId, actorId: session.user.id, userId, action });
    if (action !== 'remove' || !body.data.deleteWorkspace) {
      return Response.json({ ok: true });
    }
    // Their access is already gone; their workspace in the account is cleaned up best-effort, and the
    // admin is told if it has to be removed by hand.
    const workspaceDeleted = await deleteWorkspace(env, orgId, userId).then(
      () => true,
      () => {
        console.error('Unable to delete a removed member workspace');
        return false;
      },
    );
    return Response.json({ ok: true, workspaceDeleted });
  });
}

export function revokeInviteAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, revokeInviteSchema, 'Choose an invite to revoke.');
    if ('response' in body) {
      return body.response;
    }
    await revokeInvite(env.DB, { ...body.data, actorId: session.user.id });
    return new Response(null, { status: 204 });
  });
}

export function renameOrganizationAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, renameSchema, 'Give the team a name.');
    if ('response' in body) {
      return body.response;
    }
    await renameOrganization(env.DB, { ...body.data, actorId: session.user.id });
    return new Response(null, { status: 204 });
  });
}

/** Revokes a Cloudflare grant with Cloudflare; false when it could not be (the admin revokes it there). */
async function revokeCloudflareGrant(env: Env, credentialHandle: string): Promise<boolean> {
  return D1CloudflareCredentialVault.fromEnv(env).revokeOAuthCredential(credentialHandle);
}

/**
 * An admin deleting their team, or its only member leaving it. Each member's workspace (chats and
 * project files) is deleted from the team's Cloudflare account first, best-effort, while its
 * authorization still works; then the connection is revoked, CloudChef's grant on the account is
 * revoked with Cloudflare, and the team's records are deleted, as erasing its last member would.
 * Apps deployed from those workspaces, and their databases and storage, stay in the account, and so
 * does CloudChef's GitHub App on the GitHub account it was installed on.
 */
export function deleteOrganizationAction({
  request,
  env,
  deleteWorkspace = deleteMemberWorkspace,
  revokeGrant = revokeCloudflareGrant,
}: {
  request: Request;
  env: Env;
  deleteWorkspace?: typeof deleteMemberWorkspace;
  revokeGrant?: typeof revokeCloudflareGrant;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, deleteSchema, 'Choose a team.');
    if ('response' in body) {
      return body.response;
    }
    const { orgId } = body.data;
    const { memberIds } = await prepareOrganizationDeletion(env.DB, { orgId, actorId: session.user.id });
    const connection = await findCloudflareConnectionForOrganization(env.DB, orgId);
    let workspacesLeft = 0;
    if (connection) {
      for (const userId of memberIds) {
        // A workspace that can't be deleted (no authorization, Cloudflare unreachable) is reported.
        const deleted = await deleteWorkspace(env, orgId, userId).then(
          () => true,
          () => false,
        );
        if (!deleted) {
          workspacesLeft += 1;
        }
      }
      if (workspacesLeft > 0) {
        console.error('Unable to delete every workspace of a deleted team');
      }
    }
    const credentialHandle = await revokeOrganizationConnection(env.DB, orgId);
    const cloudflareAuthorizationRevoked = credentialHandle
      ? await revokeGrant(env, credentialHandle).catch(() => {
          console.warn('Unable to revoke the Cloudflare grant of a deleted team');
          return false;
        })
      : true;
    await deleteOrganizationRecords(env.DB, { orgId, credentialHandle });
    return Response.json({ deleted: true, workspacesLeft, cloudflareAuthorizationRevoked });
  });
}

/** Deletes a person's workspace from an organization's Cloudflare account, with the organization's authorization. */
async function deleteMemberWorkspace(env: Env, orgId: string, userId: string): Promise<void> {
  const connection = await findCloudflareConnectionForOrganization(env.DB, orgId);
  if (connection?.status !== 'active' || !connection.credentialHandle) {
    throw new Error('The team has no active Cloudflare connection.');
  }
  const accessToken = await D1CloudflareCredentialVault.fromEnv(env).resolve(connection.credentialHandle);
  await new UserCloudflareAccountApi(connection.accountId, accessToken).deleteWorkspaceRuntime(
    await workspaceRuntimeNames(connection, userId),
  );
}

/** Switches the session to another Cloudflare account the person may build in. */
export function switchContextAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async () => {
    const body = await readJsonRequest(request, contextSchema, 'Choose an account to build in.');
    if ('response' in body) {
      return body.response;
    }
    if (!(await setSessionContext(env, request, body.data.connectionId))) {
      return Response.json({ error: "You can't build in that account." }, { status: 403 });
    }
    return new Response(null, { status: 204 });
  });
}

/** Emails an invite; false when email isn't configured or sending failed (the admin still has the link). */
async function sendInvite(
  env: Env,
  invite: { to: string; orgName: string; inviter: string; link: URL },
): Promise<boolean> {
  const text = [
    `${invite.inviter} invited you to build apps with ${invite.orgName} on CloudChef.`,
    '',
    `Accept the invite: ${invite.link.toString()}`,
    '',
    `Sign in with this address (${invite.to}), with Google or an emailed link; you don't need a Cloudflare`,
    `login. What you build is stored in ${invite.orgName}'s Cloudflare account, where its administrators can`,
    'see it. The invite works once, within 7 days.',
  ].join('\n');
  try {
    await env.SIGN_IN_EMAIL.send({
      from: SENDER,
      to: invite.to,
      subject: `${invite.orgName} invited you to CloudChef`,
      text,
    });
    return true;
  } catch {
    console.error('Unable to send an organization invite');
    return false;
  }
}
