import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { createAuthSession, getAuthSession, prepareAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import {
  acceptInviteAction,
  createOrganizationAction,
  describeInviteAction,
  inviteToOrganizationAction,
  listOrganizationsAction,
  revokeInviteAction,
  switchContextAction,
  updateMemberAction,
} from './organizations';

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
});
