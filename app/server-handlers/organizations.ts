import { z } from 'zod';
import { prepareWorkspaceInBackground } from '~/server-handlers/cloudflare-integration';
import { publicOrigin } from '~/lib/.server/public-origin';
import { normalizeEmail, setSessionContext } from '~/lib/.server/auth';
import { hasSameOrigin, readJsonRequest, withinAddressRateLimit } from '~/lib/.server/request-guards';
import { SENDER } from './email-auth';
import { answeringOrganizationErrors, signedIn } from './signed-in';
import { isRecentSignIn, reauthenticationRequired } from '~/lib/.server/account-reauthentication';
import { findCloudflareConnectionForOrganization } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import {
  acceptInvite,
  createInvite,
  createOrganization,
  describeInvite,
  listOrganizations,
  organizationWorkspaceOwners,
  prepareOrganizationDeletion,
  renameOrganization,
  requireAdmin,
  revokeInvite,
  updateMember,
} from '~/lib/cloudflare/data/organizations.server';
import {
  listAccessibleProjects,
  listGitHubInstallations,
  listOwnProductionRequests,
  listScopeProjects,
} from '~/lib/cloudflare/data/org-projects.server';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { deleteTeamWorkspace } from '~/lib/.server/cloudflare/team-workspace';
import { deleteOrganization } from '~/lib/.server/cloudflare/account-deletion';

/**
 * Organizations: an admin connects the organization's Cloudflare account and invites people by email;
 * they sign in (Google or an emailed link), accept, and build in that account. Every handler needs a
 * session and a same-origin request; admin-only ones check the role on each call.
 */
const ORGANIZATION_INVITE_PATH = '/join';
/** Control and formatting characters, newlines among them: never part of a name. */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
/** A web address, or anything an email client may turn into a link, inside a name. */
const LINK_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*|\S*@\S+|\S*\w\.[a-z]{2,}\S*/gi;

/** A team's name: one line, without control characters. */
const teamNameSchema = z
  .string()
  .transform((name) => name.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1).max(80));
const createSchema = z.strictObject({ name: teamNameSchema });
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
const renameSchema = z.strictObject({ orgId: z.string().uuid(), name: teamNameSchema });
const deleteSchema = z.strictObject({ orgId: z.string().uuid() });
/** How many members' workspaces a team's deletion deletes at once. */
const WORKSPACE_DELETION_CONCURRENCY = 4;

export function listOrganizationsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const organizations = await listOrganizations(env.DB, session.user.id);
    // With each, the GitHub accounts its App is installed on and its projects: all of them, with who may view or edit each, for an
    // admin; the ones they may view or edit, with their role, for a member.
    const withProjects = await Promise.all(
      organizations.map(async (organization) => {
        const admin = organization.members !== null;
        const connection = await findCloudflareConnectionForOrganization(env.DB, organization.orgId);
        const scope = connection ? { connectionId: connection.id, orgId: organization.orgId } : null;
        const [github, projects, ownRequests] = await Promise.all([
          scope ? listGitHubInstallations(env.DB, scope.connectionId) : [],
          !scope
            ? []
            : admin
              ? listScopeProjects(env.DB, scope)
              : listAccessibleProjects(env.DB, scope.connectionId, session.user.id).then((accessible) =>
                  accessible.map((project) => ({ ...project, access: [] })),
                ),
          listOwnProductionRequests(env.DB, organization.orgId, session.user.id),
        ]);
        return {
          ...organization,
          github,
          projects: projects.map(({ id, name, repo, createdFrom, deploysWith, importSource, access }) => ({
            id,
            name,
            repo,
            createdFrom,
            deploysWith,
            importRepoFullName: importSource?.fullName ?? null,
            access,
          })),
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
    const link = new URL(ORGANIZATION_INVITE_PATH, publicOrigin(request));
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
  if (!(await withinAddressRateLimit(env.SIGN_IN_RATE_LIMITER, request))) {
    return Response.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }
  const body = await readJsonRequest(request, acceptSchema, 'This invite link is not valid.');
  if ('response' in body) {
    return body.response;
  }
  return answeringOrganizationErrors(async () => {
    const invite = await describeInvite(env.DB, body.data.token);
    return invite
      ? Response.json(invite, { headers: { 'Cache-Control': 'no-store' } })
      : Response.json({ error: 'This invite has been used or has expired. Ask for a new one.' }, { status: 410 });
  });
}

export function acceptInviteAction({
  request,
  env,
  prepareWorkspace = prepareWorkspaceInBackground,
}: {
  request: Request;
  env: Env;
  prepareWorkspace?: typeof prepareWorkspaceInBackground;
}): Promise<Response> {
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
      // Their workspace in the team's account starts preparing now, so its first setup is done when they open
      // a project.
      await prepareWorkspace(env, session.user.id, connection);
    }
    return Response.json({ orgId, switched });
  });
}

/**
 * An admin pausing, resuming, removing, promoting or demoting a member, or a member leaving. Pausing
 * or removing takes effect at the person's next request: the credential broker and the workspace
 * session both ask about membership every time. Removing someone else together with their workspace
 * deletes their chats and files for good, so it is done only from a fresh sign-in, as deleting a team is.
 */
export function updateMemberAction({
  request,
  env,
  deleteWorkspace = deleteTeamWorkspace,
}: {
  request: Request;
  env: Env;
  deleteWorkspace?: typeof deleteTeamWorkspace;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, memberSchema, 'Choose a member and what to do.');
    if ('response' in body) {
      return body.response;
    }
    const { orgId, userId, action } = body.data;
    if (action === 'remove' && body.data.deleteWorkspace && userId !== session.user.id && !isRecentSignIn(session)) {
      return reauthenticationRequired('Sign in again to confirm it is you, then remove them.');
    }
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
 * revoked with Cloudflare unless another space still builds in that account, and the team's records are
 * deleted, as erasing its last member would.
 * Apps deployed from those workspaces, and their databases and storage, stay in the account, and so
 * does CloudChef's GitHub App on the GitHub accounts it was installed on.
 */
export function deleteOrganizationAction({
  request,
  env,
  deleteWorkspace = deleteTeamWorkspace,
  revokeGrant = revokeCloudflareGrant,
}: {
  request: Request;
  env: Env;
  deleteWorkspace?: typeof deleteTeamWorkspace;
  revokeGrant?: typeof revokeCloudflareGrant;
}): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    // Irreversible for everyone in it, so only from a fresh sign-in, as erasing an account is.
    if (!isRecentSignIn(session)) {
      return reauthenticationRequired('Sign in again to confirm it is you, then delete the team.');
    }
    const body = await readJsonRequest(request, deleteSchema, 'Choose a team.');
    if ('response' in body) {
      return body.response;
    }
    const { orgId } = body.data;
    await prepareOrganizationDeletion(env.DB, { orgId, actorId: session.user.id });
    // Only the workspaces there are: a team never connected has none. One in an account CloudChef can
    // no longer reach (the connection lapsed or was revoked) can't be deleted, so it is reported left.
    const owners = await organizationWorkspaceOwners(env.DB, orgId);
    const reachable = owners.filter((owner) => owner.reachable).map((owner) => owner.userId);
    let workspacesLeft = owners.length - reachable.length;
    // A few at a time, so a large team is neither one long sequence nor a burst at Cloudflare's API.
    for (let start = 0; start < reachable.length; start += WORKSPACE_DELETION_CONCURRENCY) {
      const outcomes = await Promise.all(
        reachable.slice(start, start + WORKSPACE_DELETION_CONCURRENCY).map((userId) =>
          // A workspace that can't be deleted (no authorization, Cloudflare unreachable) is reported.
          deleteWorkspace(env, orgId, userId).then(
            () => true,
            () => false,
          ),
        ),
      );
      workspacesLeft += outcomes.filter((deleted) => !deleted).length;
    }
    if (workspacesLeft > 0) {
      console.error('Unable to delete every workspace of a deleted team');
    }
    const grant = await deleteOrganization(env.DB, orgId, (credentialHandle) => revokeGrant(env, credentialHandle));
    return Response.json({
      deleted: true,
      workspacesLeft,
      // Whether Cloudflare confirmed CloudChef's access revoked; null when there was none to revoke, or it was
      // kept because another space still builds in the account.
      cloudflareAuthorizationRevoked: grant === 'kept' ? null : grant,
      cloudflareAuthorizationKept: grant === 'kept',
    });
  });
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

/**
 * A team's or a person's name as an invite email shows it: one line, no control characters, and no
 * web or email address, since whoever chose the name could otherwise put their own link in an email
 * CloudChef sends.
 */
function nameForEmail(name: string, fallback: string): string {
  const plain = name.replace(CONTROL_CHARACTERS, ' ').replace(LINK_LIKE, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return /[\p{L}\p{N}]/u.test(plain) ? plain : fallback;
}

/** Emails an invite; false when email isn't configured or sending failed (the admin still has the link). */
async function sendInvite(
  env: Env,
  details: { to: string; orgName: string; inviter: string; link: URL },
): Promise<boolean> {
  const invite = {
    ...details,
    orgName: nameForEmail(details.orgName, 'A team'),
    inviter: nameForEmail(details.inviter, 'A team admin'),
  };
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
