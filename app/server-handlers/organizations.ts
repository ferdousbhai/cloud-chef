import { z } from 'zod';
import { setSessionContext } from '~/lib/.server/auth';
import { readJsonRequest } from '~/lib/.server/request-guards';
import { signedIn } from './signed-in';
import { isRecentSignIn, reauthenticationRequired } from '~/lib/.server/account-reauthentication';
import { findCloudflareConnectionForOrganization } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import {
  listOrganizations,
  organizationWorkspaceOwners,
  prepareOrganizationDeletion,
  updateMember,
} from '~/lib/cloudflare/data/organizations.server';
import {
  listAccessibleProjects,
  listGitHubInstallations,
  listScopeProjects,
} from '~/lib/cloudflare/data/org-projects.server';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { deleteTeamWorkspace } from '~/lib/.server/cloudflare/team-workspace';
import { deleteOrganization } from '~/lib/.server/cloudflare/account-deletion';

/**
 * Spaces: each is one connected Cloudflare account and the people who work in it. Other people come into one by
 * being added to one of its projects (`project-shares.ts`), and an admin may make one of them an admin too. Every
 * handler needs a session and a same-origin request; admin-only ones check the role on each call.
 */
/** Control and formatting characters, newlines among them: never part of a name. */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
/** A web address, or anything an email client may turn into a link, inside a name. */
const LINK_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*|\S*@\S+|\S*\w\.[a-z]{2,}\S*/gi;

const contextSchema = z.strictObject({ connectionId: z.string().min(1).max(128) });
const memberSchema = z.strictObject({
  orgId: z.string().uuid(),
  userId: z.string().min(1).max(128),
  action: z.enum(['pause', 'resume', 'remove', 'make_admin', 'make_member']),
  /** On removal, also delete their workspace (chats, project files) from the organization's account. */
  deleteWorkspace: z.boolean().default(true),
});
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
        const [github, projects] = await Promise.all([
          scope ? listGitHubInstallations(env.DB, scope.connectionId) : [],
          !scope
            ? []
            : admin
              ? listScopeProjects(env.DB, scope)
              : listAccessibleProjects(env.DB, scope.connectionId, session.user.id).then((accessible) =>
                  accessible.map((project) => ({ ...project, access: [] })),
                ),
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
        };
      }),
    );
    return Response.json({ organizations: withProjects }, { headers: { 'Cache-Control': 'private, no-store' } });
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
      return reauthenticationRequired('Sign in again to confirm it is you, then delete it.');
    }
    const body = await readJsonRequest(request, deleteSchema, 'Choose a space.');
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
 * A project's or a person's name as an email CloudChef sends shows it: one line, no control characters, and no
 * web or email address, since whoever chose the name could otherwise put their own link in an email
 * CloudChef sends.
 */
export function nameForEmail(name: string, fallback: string): string {
  const plain = name.replace(CONTROL_CHARACTERS, ' ').replace(LINK_LIKE, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return /[\p{L}\p{N}]/u.test(plain) ? plain : fallback;
}
