import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { controlPlaneDatabase, envWith, withStatementHook } from '~/test/control-plane-d1';
import { createAuthSession, getAuthSession, prepareAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import {
  acceptInviteAction,
  createOrganizationAction,
  deleteOrganizationAction,
  describeInviteAction,
  inviteToOrganizationAction,
  listOrganizationsAction,
  renameOrganizationAction,
  revokeInviteAction,
  switchContextAction,
  updateMemberAction,
} from './organizations';
import { findPendingProductionRequest, listPendingProductionRequests } from '~/lib/cloudflare/data/org-projects.server';
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
    const user = await upsertVerifiedEmailUser(db, { email });
    const cookie = (await createAuthSession(env, await prepareAuthSession(user.id))).split(';')[0];
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

const createdSchema = z.object({ orgId: z.string() });
const invitedSchema = z.object({ inviteUrl: z.string(), emailed: z.boolean() });

/** An organization whose admin has connected its Cloudflare account, as `acme-connection`. */
async function createOrg(env: Env, cookie: string, { connect = true } = {}) {
  const response = await createOrganizationAction({
    request: post(cookie, '/api/organizations/create', { name: 'Acme' }),
    env,
  });
  expect(response.status).toBe(201);
  const { orgId } = createdSchema.parse(await response.json());
  if (connect) {
    await env.DB.prepare(
      `INSERT INTO cloudflare_connections (id, org_id, account_id, account_name, status, created_at, updated_at)
       VALUES ('acme-connection', ?, 'account-acme', 'Acme', 'active', 1, 1)`,
    )
      .bind(orgId)
      .run();
  }
  return orgId;
}

async function invite(
  env: Env,
  cookie: string,
  orgId: string,
  email: string,
  options: { draftsAllowed?: boolean } = {},
) {
  const response = await inviteToOrganizationAction({
    request: post(cookie, '/api/organizations/invite', { orgId, email, ...options }),
    env,
  });
  return { status: response.status, body: response.ok ? invitedSchema.parse(await response.json()) : null };
}

function tokenOf(inviteUrl: string): string {
  return new URL(inviteUrl).searchParams.get('token') ?? '';
}

describe('organizations', () => {
  it('lets an admin invite someone by email, who joins and builds in the organization account', async () => {
    const { env, sent, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);

    const invited = await invite(env, admin.cookie, orgId, 'Sam@Acme.com');
    expect(invited.status).toBe(201);
    expect(invited.body?.emailed).toBe(true);
    expect(sent[0]).toContain('"to":"sam@acme.com"');
    expect(sent[0]).toContain(invited.body?.inviteUrl ?? 'missing');

    const sam = await signIn('sam@acme.com');
    const accepted = await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ orgId, switched: true });

    // Sam now works in Acme's account, as a member who may build new apps of their own (the invite's default).
    const session = await getAuthSession(env, new Request(ORIGIN, { headers: { cookie: sam.cookie } }));
    expect(session?.context).toMatchObject({
      kind: 'organization',
      connectionId: 'acme-connection',
      role: 'member',
      draftsAllowed: true,
    });

    // The admin sees members and invites; the member sees neither.
    const asAdmin = await listOrganizationsAction({
      request: new Request(`${ORIGIN}/api/organizations`, { headers: { cookie: admin.cookie } }),
      env,
    });
    const adminView = z
      .object({ organizations: z.array(z.object({ members: z.array(z.object({ email: z.string() })).nullable() })) })
      .parse(await asAdmin.json());
    expect(adminView.organizations[0].members?.map((member) => member.email)).toEqual(['ada@acme.com', 'sam@acme.com']);
    const asMember = await listOrganizationsAction({
      request: new Request(`${ORIGIN}/api/organizations`, { headers: { cookie: sam.cookie } }),
      env,
    });
    const memberView = z
      .object({ organizations: z.array(z.object({ members: z.null(), invites: z.null() })) })
      .safeParse(await asMember.json());
    expect(memberView.success).toBe(true);
  });

  it('joins with GitHub projects only when the inviting admin unticks building new apps', async () => {
    const { env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com', { draftsAllowed: false });

    const listed = await listOrganizationsAction({
      request: new Request(`${ORIGIN}/api/organizations`, { headers: { cookie: admin.cookie } }),
      env,
    });
    const invites = z
      .object({ organizations: z.array(z.object({ invites: z.array(z.object({ draftsAllowed: z.boolean() })) })) })
      .parse(await listed.json()).organizations[0].invites;
    expect(invites).toEqual([expect.objectContaining({ draftsAllowed: false })]);

    const sam = await signIn('sam@acme.com');
    await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });
    const session = await getAuthSession(env, new Request(ORIGIN, { headers: { cookie: sam.cookie } }));
    expect(session?.context).toMatchObject({ kind: 'organization', role: 'member', draftsAllowed: false });
  });

  it("joins an organization whose Cloudflare connection isn't active without switching into it", async () => {
    const { env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const token = tokenOf((await invite(env, admin.cookie, orgId, 'sam@acme.com')).body?.inviteUrl ?? '');
    await env.DB.prepare(`UPDATE cloudflare_connections SET status = 'error' WHERE id = 'acme-connection'`).run();

    const sam = await signIn('sam@acme.com');
    const accepted = await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token }),
      env,
    });

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ orgId, switched: false });
    const session = await getAuthSession(env, new Request(ORIGIN, { headers: { cookie: sam.cookie } }));
    expect(session?.context?.kind).not.toBe('organization');
  });

  it('tells the link holder what an invite is for, before they sign in, until it is used', async () => {
    const { env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const token = tokenOf((await invite(env, admin.cookie, orgId, 'sam@acme.com')).body?.inviteUrl ?? '');
    const describe = () =>
      describeInviteAction({ request: post('', '/api/organizations/invite/describe', { token }), env });

    const described = await describe();
    expect(described.status).toBe(200);
    expect(await described.json()).toEqual({ orgName: 'Acme', email: 'sam@acme.com', inviterName: expect.any(String) });

    const sam = await signIn('sam@acme.com');
    await acceptInviteAction({ request: post(sam.cookie, '/api/organizations/accept', { token }), env });
    expect((await describe()).status).toBe(410);
  });

  it('accepts an invite only once, and only from the invited address', async () => {
    const { env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    const token = tokenOf(invited.body?.inviteUrl ?? '');

    const eve = await signIn('eve@example.com');
    const wrongPerson = await acceptInviteAction({
      request: post(eve.cookie, '/api/organizations/accept', { token }),
      env,
    });
    expect(wrongPerson.status).toBe(403);
    // Proving eve's email wouldn't help, so the page doesn't offer it.
    expect(await wrongPerson.json()).not.toHaveProperty('code');

    const sam = await signIn('sam@acme.com');
    const first = await acceptInviteAction({ request: post(sam.cookie, '/api/organizations/accept', { token }), env });
    expect(first.status).toBe(200);
    const again = await acceptInviteAction({ request: post(sam.cookie, '/api/organizations/accept', { token }), env });
    expect(again.status).toBe(410);
  });

  it("doesn't accept an invite for someone whose email only a Cloudflare sign-in reported", async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    // A Cloudflare-only user whose Cloudflare login reports sam@acme.com: never proven by CloudChef.
    const sam = await signIn('sam@acme.com');
    database.prepare('UPDATE "user" SET email_proven_at = NULL WHERE id = ?').run(sam.userId);

    const accepted = await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });
    expect(accepted.status).toBe(403);
    // The page offers to prove the address, keeping this one account.
    expect(await accepted.json()).toMatchObject({ code: 'email_unproven' });
  });

  it('creates an organization from a session signed in a while ago', async () => {
    const { database, env } = await setup();
    const user = await upsertVerifiedEmailUser(env.DB, { email: 'ada@acme.com' });
    // Signed in an hour ago: creating needs no fresh sign-in, and connecting is approved on Cloudflare.
    const stale = await prepareAuthSession(user.id, undefined, Date.now() - 60 * 60_000);
    const cookie = (await createAuthSession(env, stale)).split(';')[0];
    const created = await createOrganizationAction({
      request: post(cookie, '/api/organizations/create', { name: 'Acme' }),
      env,
    });
    expect(created.status).toBe(201);
    expect(database.prepare('SELECT COUNT(*) AS n FROM organizations').get()).toEqual({ n: 1 });
  });

  it("doesn't send invites until the organization's Cloudflare account is connected", async () => {
    const { env, sent, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie, { connect: false });
    expect((await invite(env, admin.cookie, orgId, 'sam@acme.com')).status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it('keeps links and extra lines a team or admin put in their names out of invite emails', async () => {
    const { database, env, sent, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    database.prepare(`UPDATE "user" SET name = ? WHERE id = ?`).run('Ada\r\nBcc: www.evil.example', admin.userId);
    const created = await createOrganizationAction({
      request: post(admin.cookie, '/api/organizations/create', {
        name: 'Acme\nClaim your prize: https://evil.example/login or evil.example. Thanks',
      }),
      env,
    });
    const { orgId } = createdSchema.parse(await created.json());
    expect(database.prepare('SELECT name FROM organizations').get()).toEqual({
      name: 'Acme Claim your prize: https://evil.example/login or evil.example. Thanks',
    });
    await env.DB.prepare(
      `INSERT INTO cloudflare_connections (id, org_id, account_id, account_name, status, created_at, updated_at)
       VALUES ('acme-connection', ?, 'account-acme', 'Acme', 'active', 1, 1)`,
    )
      .bind(orgId)
      .run();

    expect((await invite(env, admin.cookie, orgId, 'sam@acme.com')).status).toBe(201);
    const email = z.object({ subject: z.string(), text: z.string() }).parse(JSON.parse(sent[0]));
    expect(email.subject).toBe('Acme Claim your prize: or Thanks invited you to CloudChef');
    expect(email.text).not.toContain('evil');
    expect(email.text.split('\n')[0]).toBe(
      'Ada Bcc: invited you to build apps with Acme Claim your prize: or Thanks on CloudChef.',
    );
  });

  it('caps the teams one person creates, and the invites they send in a day across them', async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    for (let index = 0; index < 10; index += 1) {
      const created = await createOrganizationAction({
        request: post(admin.cookie, '/api/organizations/create', { name: `Team ${index}` }),
        env,
      });
      expect(created.status).toBe(201);
    }
    const eleventh = await createOrganizationAction({
      request: post(admin.cookie, '/api/organizations/create', { name: 'Team 10' }),
      env,
    });
    expect(eleventh.status).toBe(409);

    // A hundred invites sent today from another of their teams: none more from this one.
    const orgIds = database.prepare('SELECT id FROM organizations ORDER BY name').all();
    const [first, second] = orgIds.map((row) => z.object({ id: z.string() }).parse(row).id);
    const insert = database.prepare(
      `INSERT INTO organization_quota_events (kind, user_id, org_id, created_at) VALUES ('invite', ?, ?, ?)`,
    );
    for (let index = 0; index < 100; index += 1) {
      insert.run(admin.userId, first, Date.now());
    }
    await env.DB.prepare(
      `INSERT INTO cloudflare_connections (id, org_id, account_id, account_name, status, created_at, updated_at)
       VALUES ('second-connection', ?, 'account-2', 'Second', 'active', 1, 1)`,
    )
      .bind(second)
      .run();
    expect((await invite(env, admin.cookie, second, 'sam@acme.com')).status).toBe(409);
  });

  it("doesn't give a team's creation back when the team is deleted, until 30 days have passed", async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const create = (name: string) =>
      createOrganizationAction({ request: post(admin.cookie, '/api/organizations/create', { name }), env });
    for (let index = 0; index < 10; index += 1) {
      expect((await create(`Team ${index}`)).status).toBe(201);
    }
    database.prepare(`DELETE FROM organizations WHERE name = 'Team 0'`).run();

    const again = await create('Team 10');
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'You can have up to 10 teams, and create up to 10 in 30 days.' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM organizations').get()?.count).toBe(9);

    database.prepare('UPDATE organization_quota_events SET created_at = ?').run(Date.now() - 31 * 24 * 60 * 60_000);
    expect((await create('Team 10')).status).toBe(201);
    // Nine teams before, and the tenth: the limit on teams one has stands as well.
    expect((await create('Team 11')).status).toBe(409);
  });

  it('counts a revoked invite, and one from a deleted team, toward the daily limits', async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const insert = database.prepare(
      `INSERT INTO organization_quota_events (kind, user_id, org_id, created_at) VALUES ('invite', ?, ?, ?)`,
    );
    for (let index = 0; index < 99; index += 1) {
      insert.run(admin.userId, orgId, Date.now());
    }
    expect((await invite(env, admin.cookie, orgId, 'sam@acme.com')).status).toBe(201);
    database.prepare('DELETE FROM organization_invites').run();

    expect((await invite(env, admin.cookie, orgId, 'kim@acme.com')).status).toBe(409);

    // The team deleted, its invites go, but what its admin sent still counts for them in another.
    database.prepare('DELETE FROM organizations WHERE id = ?').run(orgId);
    const otherOrgId = await createOrganizationAction({
      request: post(admin.cookie, '/api/organizations/create', { name: 'Other' }),
      env,
    }).then(async (response) => createdSchema.parse(await response.json()).orgId);
    await env.DB.prepare(
      `INSERT INTO cloudflare_connections (id, org_id, account_id, account_name, status, created_at, updated_at)
       VALUES ('other-connection', ?, 'account-other', 'Other', 'active', 1, 1)`,
    )
      .bind(otherOrgId)
      .run();
    expect((await invite(env, admin.cookie, otherOrgId, 'kim@acme.com')).status).toBe(409);
  });

  it('lets only one of two invites sent at once take the last place of the day, and counts only it', async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const insert = database.prepare(
      `INSERT INTO organization_quota_events (kind, user_id, org_id, created_at) VALUES ('invite', ?, ?, ?)`,
    );
    for (let index = 0; index < 99; index += 1) {
      insert.run(admin.userId, orgId, Date.now());
    }
    // The other invite is counted after this one checked the limits, and before it is written.
    const racing = withStatementHook(env.DB, (query) => {
      if (query.includes('INSERT INTO organization_invites')) {
        insert.run(admin.userId, orgId, Date.now());
      }
    });

    const refused = await invite({ ...env, DB: racing }, admin.cookie, orgId, 'sam@acme.com');

    expect(refused.status).toBe(409);
    expect(database.prepare('SELECT COUNT(*) AS count FROM organization_invites').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM organization_quota_events').get()).toEqual({
      count: 101,
    });
  });

  it('lets only admins invite, and only to accounts a person may use', async () => {
    const { env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const sam = await signIn('sam@acme.com');
    expect((await invite(env, sam.cookie, orgId, 'eve@example.com')).status).toBe(403);

    const switched = await switchContextAction({
      request: post(sam.cookie, '/api/context', { connectionId: 'someone-elses-connection' }),
      env,
    });
    expect(switched.status).toBe(403);
  });

  it('refuses requests from other origins and without a session', async () => {
    const { env } = await setup();
    const foreign = await createOrganizationAction({
      request: new Request(`${ORIGIN}/api/organizations/create`, {
        method: 'POST',
        headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme' }),
      }),
      env,
    });
    expect(foreign.status).toBe(403);
    const anonymous = await createOrganizationAction({
      request: post('', '/api/organizations/create', { name: 'Acme' }),
      env,
    });
    expect(anonymous.status).toBe(401);
  });

  it('pauses, resumes and removes members, and never leaves an organization without an active admin', async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    const sam = await signIn('sam@acme.com');
    await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });
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
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    const sam = await signIn('sam@acme.com');
    await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });
    const stale = await prepareAuthSession(admin.userId, undefined, Date.now() - 60 * 60_000);
    const staleCookie = (await createAuthSession(env, stale)).split(';')[0];
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
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    const sam = await signIn('sam@acme.com');
    await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });
    const stale = await prepareAuthSession(sam.userId, undefined, Date.now() - 60 * 60_000);
    const staleCookie = (await createAuthSession(env, stale)).split(';')[0];
    const left = await updateMemberAction({
      request: post(staleCookie, '/api/organizations/member', { orgId, userId: sam.userId, action: 'remove' }),
      env,
      deleteWorkspace: async () => undefined,
    });
    expect(left.status).toBe(200);
  });

  it("lapses an admin's invites once they're no longer an admin", async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    database.prepare('UPDATE organization_members SET role = ? WHERE user_id = ?').run('member', admin.userId);
    const sam = await signIn('sam@acme.com');
    const accepted = await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });
    expect(accepted.status).toBe(410);
  });

  it('lets an admin revoke a pending invite', async () => {
    const { env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    const listed = await listOrganizationsAction({
      request: new Request(`${ORIGIN}/api/organizations`, { headers: { cookie: admin.cookie } }),
      env,
    });
    const inviteId = z
      .object({ organizations: z.array(z.object({ invites: z.array(z.object({ id: z.string() })) })) })
      .parse(await listed.json()).organizations[0].invites[0].id;

    const revoked = await revokeInviteAction({
      request: post(admin.cookie, '/api/organizations/invite/revoke', { orgId, inviteId }),
      env,
    });
    expect(revoked.status).toBe(204);
    const sam = await signIn('sam@acme.com');
    const accepted = await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });
    expect(accepted.status).toBe(410);
  });
  it('gives an invited person the projects the admin chose, those still in the organization, from that admin', async () => {
    const { env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const addProject = async (id: string, repoId: number) => {
      await env.DB.prepare(
        `INSERT INTO org_projects (id, org_id, name, repo_id, repo_full_name, default_branch, origin, created_at)
         VALUES (?, ?, ?, ?, ?, 'main', 'linked', 1)`,
      )
        .bind(id, orgId, `project-${repoId}`, repoId, `acme/project-${repoId}`)
        .run();
    };
    const [site, blog, unlinked, elsewhere] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    await addProject(site, 1);
    await addProject(blog, 2);
    await addProject(unlinked, 3);

    const response = await inviteToOrganizationAction({
      request: new Request(`${ORIGIN}/api/organizations/invite`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ orgId, email: 'sam@acme.com', projectIds: [site, unlinked, elsewhere] }),
      }),
      env,
    });
    expect(response.status).toBe(201);
    const { inviteUrl } = invitedSchema.parse(await response.json());

    // The admin sees what the pending invite gives; a project from elsewhere was never kept.
    const listed = await listOrganizationsAction({
      request: new Request(`${ORIGIN}/api/organizations`, { headers: { cookie: admin.cookie } }),
      env,
    });
    const pending = z
      .object({ organizations: z.array(z.object({ invites: z.array(z.object({ projectIds: z.array(z.string()) })) })) })
      .parse(await listed.json()).organizations[0].invites[0];
    expect(pending.projectIds.toSorted()).toEqual([site, unlinked].toSorted());

    await env.DB.prepare('DELETE FROM org_projects WHERE id = ?').bind(unlinked).run();
    const sam = await signIn('sam@acme.com');
    const accepted = await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(inviteUrl) }),
      env,
    });
    expect(accepted.status).toBe(200);
    const { results } = await env.DB.prepare('SELECT project_id, granted_by FROM org_project_access WHERE user_id = ?')
      .bind(sam.userId)
      .all();
    expect(results).toEqual([{ project_id: site, granted_by: admin.userId }]);
  });

  it('refuses to invite someone already in the team, since accepting would change nothing', async () => {
    const { env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    const sam = await signIn('sam@acme.com');
    await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });

    const again = await inviteToOrganizationAction({
      request: post(admin.cookie, '/api/organizations/invite', { orgId, email: 'SAM@acme.com', role: 'admin' }),
      env,
    });

    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error:
        'sam@acme.com is already in the team. To change what they can do, use Make admin or the other buttons by their name.',
    });
    expect((await invite(env, admin.cookie, orgId, 'kim@acme.com')).status).toBe(201);
  });

  it('says an invite lapsed because its sender is no longer an admin, not that it was used', async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    const token = tokenOf(invited.body?.inviteUrl ?? '');
    database.prepare('UPDATE organization_members SET role = ? WHERE user_id = ?').run('member', admin.userId);
    const lapsed = {
      error:
        'Whoever sent this invite is no longer an admin of Acme, so it no longer works. Ask one of its admins for a new one.',
      code: 'inviter_not_admin',
    };

    const described = await describeInviteAction({
      request: post('', '/api/organizations/invite/describe', { token }),
      env,
    });
    expect(described.status).toBe(410);
    expect(await described.json()).toEqual(lapsed);
    const sam = await signIn('sam@acme.com');
    const accepted = await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token }),
      env,
    });
    expect(accepted.status).toBe(410);
    expect(await accepted.json()).toEqual(lapsed);
  });

  it("declines a removed member's open production requests, and never offers one for approval", async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    const sam = await signIn('sam@acme.com');
    await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });
    const request = (id: string, status: string) =>
      database
        .prepare(
          `INSERT INTO production_requests (id, org_id, requested_by, title, snapshot_gzip_base64, snapshot_files,
             status, created_at)
           VALUES (?, ?, ?, 'Site', 'H4sI', 1, ?, 1)`,
        )
        .run(id, orgId, sam.userId, status);
    request('11111111-1111-4111-8111-111111111111', 'pending');
    request('22222222-2222-4222-8222-222222222222', 'approved');
    expect(await listPendingProductionRequests(env.DB, orgId)).toHaveLength(1);

    const removed = await updateMemberAction({
      request: post(admin.cookie, '/api/organizations/member', { orgId, userId: sam.userId, action: 'remove' }),
      env,
      deleteWorkspace: async () => undefined,
    });
    expect(removed.status).toBe(200);

    expect(
      database
        .prepare('SELECT id, status, decided_by, decision_note, snapshot_gzip_base64 FROM production_requests')
        .all(),
    ).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'declined',
        decided_by: admin.userId,
        decision_note: 'They were removed from the team.',
        snapshot_gzip_base64: '',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        status: 'approved',
        decided_by: null,
        decision_note: null,
        snapshot_gzip_base64: 'H4sI',
      },
    ]);
    // A request left open from someone no longer in the team (from before removal declined them) is
    // neither listed nor approvable.
    request('33333333-3333-4333-8333-333333333333', 'pending');
    expect(await listPendingProductionRequests(env.DB, orgId)).toEqual([]);
    expect(await findPendingProductionRequest(env.DB, orgId, '33333333-3333-4333-8333-333333333333')).toBeNull();
  });

  it("removes a member together with their grants or not at all, so none come back if they're invited again", async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    const sam = await signIn('sam@acme.com');
    await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });
    database.exec(`
      INSERT INTO org_projects (id, org_id, name, repo_id, repo_full_name, default_branch, origin, created_at)
        VALUES ('site', '${orgId}', 'Site', 1, 'acme/site', 'main', 'linked', 1);
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
    await expect(remove(env.DB, admin.userId, admin.userId)).rejects.toThrow('a team always needs one');
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
    const orgId = await createOrg(env, admin.cookie);
    const invited = await invite(env, admin.cookie, orgId, 'sam@acme.com');
    const sam = await signIn('sam@acme.com');
    await acceptInviteAction({
      request: post(sam.cookie, '/api/organizations/accept', { token: tokenOf(invited.body?.inviteUrl ?? '') }),
      env,
    });
    database.exec(
      `INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, key_version, created_at)
       VALUES ('acme-credential', 'x', 'y', 1, 1);
       UPDATE cloudflare_connections SET credential_handle = 'acme-credential' WHERE id = 'acme-connection';`,
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

  it('is renamed by an admin, and by nobody else', async () => {
    const { database, env, admin, sam, orgId } = await team();
    const rename = (cookie: string, name: string) =>
      renameOrganizationAction({ request: post(cookie, '/api/organizations/rename', { orgId, name }), env });

    expect((await rename(sam.cookie, 'Sam’s')).status).toBe(403);
    expect((await rename(admin.cookie, '   ')).status).toBe(400);
    expect((await rename(admin.cookie, '  Acme Labs ')).status).toBe(204);
    expect(database.prepare('SELECT name FROM organizations').all()).toEqual([{ name: 'Acme Labs' }]);
    // A name is one line, without control characters, as when a team is created.
    expect((await rename(admin.cookie, 'Acme\r\nLabs\u0000')).status).toBe(204);
    expect(database.prepare('SELECT name FROM organizations').all()).toEqual([{ name: 'Acme Labs' }]);
  });

  it('is deleted only from a sign-in within the last few minutes, as an account is erased', async () => {
    const { database, env, admin, orgId } = await team();
    const stale = await prepareAuthSession(admin.userId, undefined, Date.now() - 60 * 60_000);
    const staleCookie = (await createAuthSession(env, stale)).split(';')[0];

    const { response, deleted, revoked } = remove(env, staleCookie, orgId);
    const refused = await response;

    expect(refused.status).toBe(401);
    await expect(refused.json()).resolves.toEqual({
      code: 'reauthentication_required',
      error: 'Sign in again to confirm it is you, then delete the team.',
    });
    expect({ deleted, revoked }).toEqual({ deleted: [], revoked: [] });
    expect(database.prepare('SELECT COUNT(*) AS n FROM organizations').get()).toEqual({ n: 1 });
    expect((await remove(env, admin.cookie, orgId).response).status).toBe(200);
  });

  it("is deleted by an admin with every member's workspace and every record of it, its grant revoked", async () => {
    const { database, env, admin, sam, orgId } = await team();
    database
      .prepare(
        `INSERT INTO github_installations (org_id, installation_id, account_login, account_type, created_at, updated_at)
         VALUES (?, 7, 'acme', 'Organization', 1, 1)`,
      )
      .run(orgId);
    database
      .prepare(
        `INSERT INTO org_projects (id, org_id, name, repo_id, repo_full_name, default_branch, origin, created_at)
         VALUES ('44444444-4444-4444-8444-444444444444', ?, 'Site', 1, 'acme/site', 'main', 'linked', 1)`,
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
        `INSERT INTO production_requests (id, org_id, requested_by, title, snapshot_gzip_base64, snapshot_files,
           status, created_at)
         VALUES ('55555555-5555-4555-8555-555555555555', ?, ?, 'Draft', 'H4sI', 1, 'pending', 1)`,
      )
      .run(orgId, sam.userId);
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
    await invite(env, admin.cookie, orgId, 'kim@acme.com');

    // A member can't delete it.
    expect((await remove(env, sam.cookie, orgId).response).status).toBe(403);

    const { response, deleted, revoked } = remove(env, admin.cookie, orgId, { failFor: sam.userId });
    expect(await (await response).json()).toEqual({
      deleted: true,
      workspacesLeft: 1,
      cloudflareAuthorizationRevoked: true,
    });
    expect(deleted).toEqual([admin.userId]);
    expect(revoked).toEqual(['acme-credential']);
    for (const table of [
      'organizations',
      'organization_members',
      'organization_invites',
      'github_installations',
      'org_projects',
      'org_project_access',
      'production_requests',
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

  it('is deleted, not left, when its only member leaves', async () => {
    const { database, env, signIn } = await setup();
    const admin = await signIn('ada@acme.com');
    const orgId = await createOrg(env, admin.cookie);

    const left = await updateMemberAction({
      request: post(admin.cookie, '/api/organizations/member', { orgId, userId: admin.userId, action: 'remove' }),
      env,
      deleteWorkspace: async () => undefined,
    });
    expect(left.status).toBe(409);
    expect(await left.json()).toEqual({
      error: "You're the only one in Acme, so leaving deletes the team.",
      code: 'sole_member',
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 1 });

    // Even paused, the only member may delete it, since nobody else could.
    database.prepare('UPDATE organization_members SET paused_at = 1').run();
    const { response, deleted } = remove(env, admin.cookie, orgId);
    expect(await (await response).json()).toEqual({
      deleted: true,
      workspacesLeft: 0,
      cloudflareAuthorizationRevoked: true,
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
      const person = await upsertVerifiedEmailUser(env.DB, { email: `p${index}@acme.com` });
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
