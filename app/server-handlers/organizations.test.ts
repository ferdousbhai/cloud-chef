import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  controlPlaneDatabase,
  createProvenEmailUser,
  createSpace,
  envWith,
  sessionCookieSignedInBefore,
  withStatementHook,
} from '~/test/control-plane-d1';
import { createAuthSession, getAuthSession } from '~/lib/.server/auth';
import {
  deleteOrganizationAction,
  listOrganizationsAction,
  switchContextAction,
  updateMemberAction,
} from './organizations';
import { updateMember } from '~/lib/cloudflare/data/organizations.server';

const ORIGIN = 'https://cloudchef.build';

async function setup() {
  const { database, db } = controlPlaneDatabase();
  const sent: string[] = [];
  const env = envWith({
    DB: db,
    SIGN_IN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SIGN_IN_EMAIL: {
      send: async (message: EmailMessage | EmailMessageBuilder) => {
        sent.push(JSON.stringify(message));
        return { messageId: 'm' };
      },
    },
  });
  /** A signed-in person, by email: their session cookie. */
  const signIn = async (email: string) => {
    const user = await createProvenEmailUser(db, email);
    const cookie = (await createAuthSession(env, user.id, new Request('https://cloudchef.build/'))).cookie.split(
      ';',
    )[0];
    return { userId: user.id, cookie };
  };
  return { database, env, sent, signIn };
}

function post(cookie: string, path: string, body: Record<string, string | boolean>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

const listedSchema = z.object({
  organizations: z.array(
    z.looseObject({
      orgId: z.string(),
      role: z.string(),
      members: z.array(z.looseObject({ role: z.string() })).nullable(),
    }),
  ),
});

/** A space beside Ada's own whose admin has connected its Cloudflare account, as `acme-connection`. */
async function createOrg(env: Env, adminId: string) {
  const orgId = await createSpace(env.DB, adminId, 'Acme');
  await env.DB.prepare(
    `INSERT INTO cloudflare_connections (id, org_id, account_id, account_name, status, created_at, updated_at)
     VALUES ('acme-connection', ?, 'account-acme', 'Acme', 'active', 1, 1)`,
  )
    .bind(orgId)
    .run();
  return orgId;
}

/** Someone in the space as a project shared with them leaves them: not an admin. */
async function join(env: Env, orgId: string, userId: string) {
  await env.DB.prepare("INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'member', 1)")
    .bind(orgId, userId)
    .run();
}

describe('the people in a space', () => {
  it('shows who is in it to its admins only, and opens only for the people in it', async () => {
    const { env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.userId);
    const sam = await signIn('sam@acme.com');
    const eve = await signIn('eve@example.com');
    await join(env, orgId, sam.userId);
    const listed = async (cookie: string) =>
      listedSchema
        .parse(
          await (
            await listOrganizationsAction({
              request: new Request(`${ORIGIN}/api/organizations`, { headers: { cookie } }),
              env,
            })
          ).json(),
        )
        .organizations.find((organization) => organization.orgId === orgId);

    expect((await listed(admin.cookie))?.members?.map((member) => member.role)).toEqual(
      expect.arrayContaining(['admin', 'member']),
    );
    expect(await listed(sam.cookie)).toMatchObject({ role: 'member', members: null });
    expect(await listed(eve.cookie)).toBeUndefined();

    const open = (cookie: string) =>
      switchContextAction({ request: post(cookie, '/api/context', { connectionId: 'acme-connection' }), env });
    expect((await open(sam.cookie)).status).toBe(204);
    expect((await open(eve.cookie)).status).toBe(403);
  });

  it('pauses, resumes and removes members, and never leaves an organization without an active admin', async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.userId);
    const sam = await signIn('sam@acme.com');
    await join(env, orgId, sam.userId);
    const deleted: string[] = [];
    const act = async (cookie: string, userId: string, action: string, deleteWorkspace = true) =>
      updateMemberAction({
        request: post(cookie, '/api/organizations/member', { orgId, userId, action, deleteWorkspace }),
        env,
        deleteWorkspace: async (_env, _orgId, removed) => {
          deleted.push(removed);
        },
      });
    const samContext = async () =>
      (await getAuthSession(env, new Request(ORIGIN, { headers: { cookie: sam.cookie } })))?.context ?? null;

    // A member can't manage others, and the only admin can't step down.
    expect((await act(sam.cookie, admin.userId, 'pause')).status).toBe(403);
    expect((await act(admin.cookie, admin.userId, 'make_member')).status).toBe(409);
    expect((await act(admin.cookie, admin.userId, 'remove')).status).toBe(409);

    // Paused, Sam loses the organization's account at once; resumed, it's back.
    expect((await act(admin.cookie, sam.userId, 'pause')).status).toBe(200);
    expect(await samContext()).toBeNull();
    expect((await act(admin.cookie, sam.userId, 'resume')).status).toBe(200);
    expect(await samContext()).toMatchObject({ connectionId: 'acme-connection' });

    // With a second admin, the first may step down.
    expect((await act(admin.cookie, sam.userId, 'make_admin')).status).toBe(200);
    expect((await act(admin.cookie, admin.userId, 'make_member')).status).toBe(200);

    // Removing someone ends their access and cleans up their workspace in the account.
    const removed = await act(sam.cookie, admin.userId, 'remove');
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ ok: true, workspaceDeleted: true });
    expect(deleted).toEqual([admin.userId]);
    expect(database.prepare('SELECT user_id FROM organization_members').all()).toEqual([{ user_id: sam.userId }]);
  });
  it("deletes another member's workspace only from a sign-in within the last few minutes", async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.userId);
    const sam = await signIn('sam@acme.com');
    await join(env, orgId, sam.userId);
    const staleCookie = await sessionCookieSignedInBefore(env, admin.userId, 60 * 60_000);
    const deleted: string[] = [];
    const remove = (cookie: string, deleteWorkspace: boolean) =>
      updateMemberAction({
        request: post(cookie, '/api/organizations/member', {
          orgId,
          userId: sam.userId,
          action: 'remove',
          deleteWorkspace,
        }),
        env,
        deleteWorkspace: async (_env, _orgId, removed) => {
          deleted.push(removed);
        },
      });

    const refused = await remove(staleCookie, true);
    expect(refused.status).toBe(401);
    await expect(refused.json()).resolves.toEqual({
      code: 'reauthentication_required',
      error: 'Sign in again to confirm it is you, then remove them.',
    });
    expect(deleted).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) AS n FROM organization_members').get()).toEqual({ n: 2 });

    // Removing them while keeping their workspace deletes nothing, so the same session may.
    expect((await remove(staleCookie, false)).status).toBe(200);
    expect(deleted).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) AS n FROM organization_members').get()).toEqual({ n: 1 });
  });
  it('lets a member leave, deleting their own workspace, from a sign-in made a while ago', async () => {
    const { env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.userId);
    const sam = await signIn('sam@acme.com');
    await join(env, orgId, sam.userId);
    const staleCookie = await sessionCookieSignedInBefore(env, sam.userId, 60 * 60_000);
    const left = await updateMemberAction({
      request: post(staleCookie, '/api/organizations/member', { orgId, userId: sam.userId, action: 'remove' }),
      env,
      deleteWorkspace: async () => undefined,
    });
    expect(left.status).toBe(200);
  });
  it("removes a member together with their grants or not at all, so none come back if they're added again", async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.userId);
    const sam = await signIn('sam@acme.com');
    await join(env, orgId, sam.userId);
    database.exec(`
      INSERT INTO org_projects (id, connection_id, org_id, name, artifact_repo, created_from, created_at)
        VALUES ('site', 'acme-connection', '${orgId}', 'Site', 'p-site', 'chat', 1);
      INSERT INTO org_project_access (project_id, user_id, granted_at) VALUES ('site', '${sam.userId}', 1);
      INSERT INTO user_computer_runtimes
        (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
         last_error, created_at, updated_at)
        VALUES ('${sam.userId}', 'acme-connection', 1, 'worker', 'https://runtime.example', 'sha', 'ready', NULL, 1, 1),
          ('${admin.userId}', 'acme-connection', 1, 'worker', 'https://runtime.example', 'sha', 'ready', NULL, 1, 1);
    `);
    const grants = () => ({
      members: database.prepare('SELECT user_id FROM organization_members ORDER BY role').all(),
      access: database.prepare('SELECT user_id FROM org_project_access').all(),
      runtimes: database.prepare('SELECT user_id FROM user_computer_runtimes ORDER BY user_id').all(),
    });
    const before = grants();
    const remove = (db: D1Database, actorId: string, userId: string) =>
      updateMember(db, { orgId, actorId, userId, action: 'remove' });

    // The Worker stops while the removal is written: Sam is still in the team, with everything they had.
    const stopping = withStatementHook(env.DB, (query) => {
      if (query.includes('DELETE FROM org_project_access')) {
        throw new Error('Worker stopped');
      }
    });
    await expect(remove(stopping, admin.userId, sam.userId)).rejects.toThrow('Worker stopped');
    expect(grants()).toEqual(before);

    // The only admin leaving is refused, and keeps their workspace.
    await expect(remove(env.DB, admin.userId, admin.userId)).rejects.toThrow('an account always needs one');
    expect(grants()).toEqual(before);

    await remove(env.DB, admin.userId, sam.userId);
    expect(grants()).toEqual({
      members: [{ user_id: admin.userId }],
      access: [],
      runtimes: [{ user_id: admin.userId }],
    });
  });
});

describe('a team’s name and deletion', () => {
  /** Acme with Ada as admin and Sam as member, its connection holding a stored authorization. */
  async function team() {
    const context = await setup();
    const { database, env, signIn } = context;
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.userId);
    const sam = await signIn('sam@acme.com');
    await join(env, orgId, sam.userId);
    database.exec(
      `INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, key_version, created_at)
       VALUES ('acme-credential', 'x', 'y', 1, 1);
       INSERT INTO cloudflare_authorizations (account_id, credential_handle, created_at, updated_at)
       VALUES ('account-acme', 'acme-credential', 1, 1);`,
    );
    return { ...context, admin, sam, orgId };
  }

  function remove(env: Env, cookie: string, orgId: string, outcomes: { failFor?: string } = {}) {
    const deleted: string[] = [];
    const revoked: string[] = [];
    const response = deleteOrganizationAction({
      request: post(cookie, '/api/organizations/delete', { orgId }),
      env,
      deleteWorkspace: async (_env, _orgId, userId) => {
        if (userId === outcomes.failFor) {
          throw new Error('Cloudflare is unavailable');
        }
        deleted.push(userId);
      },
      revokeGrant: async (_env, handle) => {
        revoked.push(handle);
        return true;
      },
    });
    return { response, deleted, revoked };
  }

  it('is deleted only from a sign-in within the last few minutes, as an account is erased', async () => {
    const { database, env, admin, orgId } = await team();
    const staleCookie = await sessionCookieSignedInBefore(env, admin.userId, 60 * 60_000);

    const { response, deleted, revoked } = remove(env, staleCookie, orgId);
    const refused = await response;

    expect(refused.status).toBe(401);
    await expect(refused.json()).resolves.toEqual({
      code: 'reauthentication_required',
      error: 'Sign in again to confirm it is you, then delete it.',
    });
    expect({ deleted, revoked }).toEqual({ deleted: [], revoked: [] });
    expect(database.prepare('SELECT COUNT(*) AS n FROM organizations').get()).toEqual({ n: 1 });
    expect((await remove(env, admin.cookie, orgId).response).status).toBe(200);
  });

  it("is deleted by an admin with every member's workspace and every record of it, its grant revoked", async () => {
    const { database, env, admin, sam, orgId } = await team();
    database
      .prepare(
        `INSERT INTO github_installations (connection_id, installation_id, account_login, account_type, created_at, updated_at)
         VALUES ('acme-connection', 7, 'acme', 'Organization', 1, 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO org_projects (id, connection_id, org_id, name, artifact_repo, created_from, created_at)
         VALUES ('44444444-4444-4444-8444-444444444444', 'acme-connection', ?, 'Site', 'p-site', 'chat', 1)`,
      )
      .run(orgId);
    database
      .prepare(
        `INSERT INTO org_project_access (project_id, user_id, granted_at)
         VALUES ('44444444-4444-4444-8444-444444444444', ?, 1)`,
      )
      .run(sam.userId);
    database
      .prepare(
        `INSERT INTO user_computer_runtimes
           (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
            last_error, created_at, updated_at)
         VALUES (?, 'acme-connection', 1, 'worker', 'https://runtime.example', 'sha', 'ready', NULL, 1, 1)`,
      )
      .run(sam.userId);
    database
      .prepare(
        `INSERT INTO user_computer_runtimes
           (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
            last_error, created_at, updated_at)
         VALUES (?, 'acme-connection', 1, 'worker-2', 'https://runtime-2.example', 'sha', 'ready', NULL, 1, 1)`,
      )
      .run(admin.userId);

    // A member can't delete it.
    expect((await remove(env, sam.cookie, orgId).response).status).toBe(403);

    const { response, deleted, revoked } = remove(env, admin.cookie, orgId, { failFor: sam.userId });
    expect(await (await response).json()).toEqual({
      deleted: true,
      workspacesLeft: 1,
      cloudflareAuthorizationRevoked: true,
      cloudflareAuthorizationKept: false,
    });
    expect(deleted).toEqual([admin.userId]);
    expect(revoked).toEqual(['acme-credential']);
    for (const table of [
      'organizations',
      'organization_members',
      'github_installations',
      'org_projects',
      'org_project_access',
      'cloudflare_connections',
      'cloudflare_credentials',
      'user_computer_runtimes',
    ]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    // Both people keep their CloudChef accounts, now with no account to build in.
    expect(database.prepare('SELECT COUNT(*) AS count FROM "user"').get()).toEqual({ count: 2 });
    const session = await getAuthSession(env, new Request(ORIGIN, { headers: { cookie: sam.cookie } }));
    expect(session?.context).toBeNull();
  });

  it("keeps CloudChef's access to the account while someone's own space still builds in it, and says so", async () => {
    const { database, env, admin, orgId } = await team();
    database
      .prepare(
        `INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
         VALUES ('ada-own', ?, 'account-acme', 'active', 1, 1)`,
      )
      .run(admin.userId);

    const { response, revoked } = remove(env, admin.cookie, orgId);
    expect(await (await response).json()).toEqual({
      deleted: true,
      workspacesLeft: 0,
      cloudflareAuthorizationRevoked: null,
      cloudflareAuthorizationKept: true,
    });
    expect(revoked).toEqual([]);
    expect(database.prepare('SELECT credential_handle FROM cloudflare_authorizations').all()).toEqual([
      { credential_handle: 'acme-credential' },
    ]);
  });

  it('is deleted, not left, when its only member leaves', async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.userId);

    const left = await updateMemberAction({
      request: post(admin.cookie, '/api/organizations/member', { orgId, userId: admin.userId, action: 'remove' }),
      env,
      deleteWorkspace: async () => undefined,
    });
    expect(left.status).toBe(409);
    expect(await left.json()).toEqual({
      error: "You're the only one in Acme, so leaving deletes it.",
      code: 'sole_member',
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 1 });

    // Even paused, the only member may delete it, since nobody else could.
    database.prepare('UPDATE organization_members SET paused_at = 1').run();
    const { response, deleted } = remove(env, admin.cookie, orgId);
    expect(await (await response).json()).toEqual({
      deleted: true,
      workspacesLeft: 0,
      // Its account was never authorized: there was nothing to revoke.
      cloudflareAuthorizationRevoked: null,
      cloudflareAuthorizationKept: false,
    });
    // They never opened a workspace there, so there was none to delete.
    expect(deleted).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 0 });
  });

  it('reports the workspaces of a team whose connection lapsed as left behind, trying none', async () => {
    const { database, env, admin, sam, orgId } = await team();
    database
      .prepare(
        `INSERT INTO user_computer_runtimes
           (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
            last_error, created_at, updated_at)
         VALUES (?, 'acme-connection', 1, 'worker', 'https://runtime.example', 'sha', 'ready', NULL, 1, 1)`,
      )
      .run(sam.userId);
    database.prepare("UPDATE cloudflare_connections SET status = 'revoked'").run();

    const { response, deleted } = remove(env, admin.cookie, orgId, { failFor: sam.userId });

    expect(await (await response).json()).toMatchObject({ deleted: true, workspacesLeft: 1 });
    expect(deleted).toEqual([]);
  });

  it("deletes a large team's workspaces a few at a time, and each of them", async () => {
    const { database, env, admin, orgId } = await team();
    const insertRuntime = database.prepare(
      `INSERT INTO user_computer_runtimes
         (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
          last_error, created_at, updated_at)
       VALUES (?, 'acme-connection', 1, ?, 'https://runtime.example', 'sha', 'ready', NULL, 1, 1)`,
    );
    const owners: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const person = await createProvenEmailUser(env.DB, `p${index}@acme.com`);
      insertRuntime.run(person.id, `worker-${index}`);
      owners.push(person.id);
    }
    let running = 0;
    let mostAtOnce = 0;
    const deleted: string[] = [];

    const response = await deleteOrganizationAction({
      request: post(admin.cookie, '/api/organizations/delete', { orgId }),
      env,
      deleteWorkspace: async (_env, _orgId, userId) => {
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        deleted.push(userId);
      },
      revokeGrant: async () => true,
    });

    expect(await response.json()).toMatchObject({ deleted: true, workspacesLeft: 0 });
    expect(deleted.toSorted()).toEqual(owners.toSorted());
    expect(mostAtOnce).toBeGreaterThan(1);
    expect(mostAtOnce).toBeLessThanOrEqual(4);
  });
});
