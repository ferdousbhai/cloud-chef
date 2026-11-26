import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { USER_WORKSPACE_IMAGE } from '~/lib/.server/cloudflare/user-workspace-image';
import { runtimeIdentityHeaders } from '~/lib/.server/cloudflare/runtime-identity-headers';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { createAuthSession, getAuthSession } from '~/lib/.server/auth';
import { listWorkspaceContexts } from '~/lib/cloudflare/data/organization-access.server';
import { findAccessibleProject } from '~/lib/cloudflare/data/org-projects.server';
import {
  acceptInvitationsForUser,
  listProjectPeople,
  PROJECT_INVITATION_TTL_MS,
} from '~/lib/cloudflare/data/project-shares.server';
import { readSharedCapabilitySubject } from '~/lib/.server/cloudflare/shared-project';
import { controlPlaneDatabase, createProvenEmailUser, envWith } from '~/test/control-plane-d1';
import {
  acceptProjectInvitationAction,
  addProjectShareAction,
  describeProjectInvitationAction,
  projectSharingAction,
  setProjectInvitationAction,
  setProjectPersonAction,
  sharedWithMeAction,
} from './project-shares';
import { runtimeSharedAction } from './runtime-shared';
import { runtimeMainPushedAction, runtimeOpenProjectAction } from './runtime-projects';
import { runtimeDeploymentClaimAction } from './runtime-deployments';

const ORIGIN = 'https://cloudchef.build';
const KEY = btoa('k'.repeat(32));
const RECIPES = '44444444-4444-4444-8444-444444444444';
const COMMIT = 'a'.repeat(40);

const sentEmailSchema = z.looseObject({ to: z.string(), subject: z.string(), text: z.string() });
const answerSchema = z.record(z.string(), z.unknown());
const sharedWithMeSchema = z.object({
  projects: z.array(
    z.looseObject({
      name: z.string(),
      role: z.string(),
      ownerName: z.string().nullable(),
      connectionId: z.string(),
    }),
  ),
});
const claimedSchema = z.looseObject({ restricted: z.boolean() });
const capabilitySchema = z.looseObject({ subject: z.string() });

const sharingSchema = z.looseObject({
  people: z.array(z.looseObject({ userId: z.string(), name: z.string(), role: z.string() })),
  invitations: z.array(z.looseObject({ id: z.string(), email: z.string(), role: z.string() })),
  done: z.unknown().optional(),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * Ada's own project Recipe Box in her own account, and Bo and Cy, each with an account of their own. Every one of them
 * has a workspace runtime CloudChef can reach in their own account, and `runtime` can ask as their runtime in someone
 * else's (`in`), which someone added to a project there has. Sent emails are kept.
 */
async function world() {
  const { database, db } = controlPlaneDatabase();
  const emails: { to: string; subject: string; text: string }[] = [];
  const env = envWith({
    DB: db,
    CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: KEY,
    SIGN_IN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SIGN_IN_EMAIL: {
      send: async (message: EmailMessage | EmailMessageBuilder) => {
        emails.push(sentEmailSchema.parse(message));
        return { messageId: 'sent' };
      },
    },
  });
  const person = async (email: string, username: string) => {
    const user = await createProvenEmailUser(db, email);
    await db.prepare('UPDATE "user" SET username = ? WHERE id = ?').bind(username, user.id).run();
    const cookie = (await createAuthSession(env, user.id, new Request(`${ORIGIN}/`))).cookie.split(';')[0]!;
    const connection = `${username}-own`;
    database.exec(`
      INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at)
        VALUES ('cred-${username}', 'x', 'y', 1);
      INSERT INTO cloudflare_authorizations (account_id, credential_handle, created_at, updated_at)
        VALUES ('account-${username}', 'cred-${username}', 1, 1);
    `);
    database
      .prepare(
        `INSERT INTO cloudflare_connections (id, user_id, account_id, status, connection_generation, created_at,
           updated_at) VALUES (?, ?, ?, 'active', 1, 1, 1)`,
      )
      .run(connection, user.id, `account-${username}`);
    database
      .prepare(
        `INSERT INTO user_computer_runtimes (user_id, connection_id, connection_generation, worker_name, endpoint,
           runtime_version, image_digest, protocol_version, status, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'ready', 1, 1)`,
      )
      .run(
        user.id,
        connection,
        `${username}-worker`,
        `https://${username}.runtime.test`,
        USER_WORKSPACE_RUNTIME_SHA256,
        USER_WORKSPACE_IMAGE,
        USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
      );
    /**
     * A request from this person's runtime, as every runtime route is called: in their own account, or (`in`) in the
     * account of the person named, where their workspace has a name and secret of its own.
     */
    const runtime = async (
      path: string,
      init: { method?: string; body?: string; headers?: HeadersInit; in?: string } = {},
    ) => {
      const account = init.in ?? username;
      const secret = await deriveUserWorkspaceRuntimeSecret({
        encryptionKeyBase64: KEY,
        userId: user.id,
        accountId: `account-${account}`,
        connectionGeneration: 1,
        organizationConnectionId: init.in ? `${account}-own` : null,
      });
      return new Request(`${ORIGIN}${path}`, {
        method: init.method ?? 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          ...runtimeIdentityHeaders({ userId: user.id, connectionId: `${account}-own`, connectionGeneration: 1 }),
          ...init.headers,
        },
        body: init.body,
      });
    };
    const browser = (path: string, body?: Record<string, string | boolean | null>) =>
      new Request(`${ORIGIN}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
    return { userId: user.id, email: user.email, cookie, connection, runtime, browser };
  };
  const ada = await person('ada@example.com', 'ada');
  const bo = await person('bo@example.com', 'bo');
  const cy = await person('cy@example.com', 'cy');
  database
    .prepare(
      `INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, deploys_with, created_by,
         created_at) VALUES (?, 'ada-own', 'Recipe Box', 'recipe-box', 't-recipes', 'chat', 'cloudchef', ?, 1)`,
    )
    .run(RECIPES, ada.userId);
  const sharing = `/api/projects/${RECIPES}/sharing`;
  const share = async (as: { browser: typeof ada.browser }, to: string, role: 'view' | 'edit') => {
    const response = await addProjectShareAction({ request: as.browser(`${sharing}/add`, { to, role }), env });
    return { status: response.status, body: answerSchema.parse(await response.json()) };
  };
  const tokenOf = (email: string) => {
    const message = emails.findLast((sent) => sent.to === email);
    return message ? (/token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1] ?? null) : null;
  };
  return { database, db, env, emails, ada, bo, cy, sharing, share, tokenOf };
}

describe('sharing a project', () => {
  it('shares with a username at once, telling them, and lists them by name without their address', async () => {
    const { env, db, ada, bo, share, sharing, emails } = await world();
    const shared = await share(ada, 'bo', 'edit');
    expect(shared.status).toBe(200);
    expect(shared.body.done).toEqual({ shared: 'bo' });
    const listed = sharingSchema.parse(
      await (await projectSharingAction({ request: ada.browser(sharing), env })).json(),
    );
    expect(listed.people.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: 'ada', role: 'owner' },
      { name: 'bo', role: 'edit' },
    ]);
    expect(JSON.stringify(listed)).not.toContain('bo@example.com');
    // Bo is told, in CloudChef and by email.
    const told = await db
      .prepare(`SELECT kind, actor_id, project_id FROM notifications WHERE user_id = ?`)
      .bind(bo.userId)
      .all();
    expect(told.results).toEqual([{ kind: 'project_shared', actor_id: ada.userId, project_id: RECIPES }]);
    expect(emails.map((email) => email.to)).toEqual(['bo@example.com']);
    expect(await findAccessibleProject(db, RECIPES, bo.userId)).toMatchObject({ role: 'edit' });
    // He works on it in Ada's account, beside his own: there he runs nothing and starts no apps of his own.
    expect(
      (await listWorkspaceContexts(db, bo.userId)).map(({ connectionId, role, draftsAllowed }) => ({
        connectionId,
        role,
        draftsAllowed,
      })),
    ).toEqual([
      { connectionId: 'bo-own', role: 'admin', draftsAllowed: true },
      { connectionId: 'ada-own', role: 'member', draftsAllowed: false },
    ]);
  });

  it('invites every address the same way, so the person sharing never learns whether it has an account', async () => {
    const { env, db, ada, cy, share, sharing, tokenOf } = await world();
    const known = await share(ada, 'CY@example.com', 'view');
    const unknown = await share(ada, 'newcomer@example.com', 'edit');
    expect(known.body.done).toEqual({ invited: 'cy@example.com' });
    expect(unknown.body.done).toEqual({ invited: 'newcomer@example.com' });
    const listed = sharingSchema.parse(
      await (await projectSharingAction({ request: ada.browser(sharing), env })).json(),
    );
    expect(listed.people.map((person) => person.name)).toEqual(['ada']);
    expect(listed.invitations.map(({ email, role }) => ({ email, role }))).toEqual([
      { email: 'cy@example.com', role: 'view' },
      { email: 'newcomer@example.com', role: 'edit' },
    ]);
    expect(tokenOf('newcomer@example.com')).not.toBeNull();
    // Cy, who has proven that address, takes it as soon as she looks at her projects: it is listed beside her own
    // account's, with the account opening it switches to.
    const mine = sharedWithMeSchema.parse(
      await (await sharedWithMeAction({ request: cy.browser('/api/projects/shared'), env })).json(),
    );
    expect(mine.projects).toEqual([
      expect.objectContaining({ name: 'Recipe Box', role: 'view', ownerName: 'ada', connectionId: 'ada-own' }),
    ]);
    expect(await findAccessibleProject(db, RECIPES, cy.userId)).toMatchObject({ role: 'view' });
    // Its card shows who is on it, whoever runs it first, by name and never by address.
    expect(await listProjectPeople(db, [RECIPES])).toEqual(
      new Map([
        [
          RECIPES,
          [
            { userId: ada.userId, name: 'ada', image: null, role: 'owner' },
            { userId: cy.userId, name: 'cy', image: null, role: 'view' },
          ],
        ],
      ]),
    );
  });

  it('refuses anyone who doesn’t run the project, even someone it is shared with to edit', async () => {
    const { env, ada, bo, cy, share, sharing } = await world();
    await share(ada, 'bo', 'edit');
    for (const request of [
      bo.browser(sharing),
      bo.browser(`${sharing}/add`, { to: 'cy', role: 'edit' }),
      cy.browser(`${sharing}/person`, { userId: bo.userId, role: null }),
    ]) {
      const handler = request.url.endsWith('/add')
        ? addProjectShareAction
        : request.url.endsWith('/person')
          ? setProjectPersonAction
          : projectSharingAction;
      expect((await handler({ request, env })).status).toBe(404);
    }
  });

  it('opens it in the project’s own account for someone added, who publishes there as a collaborator', async () => {
    const { env, ada, bo, share } = await world();
    await share(ada, 'bo', 'edit');
    const open = (from: { in?: string }) =>
      bo
        .runtime('/api/cloudflare/runtime-projects/open', { body: JSON.stringify({ orgProjectId: RECIPES }), ...from })
        .then((request) => runtimeOpenProjectAction({ request, env, app: null }));
    const opened = await open({ in: 'ada' });
    expect(opened.status).toBe(200);
    // His workspace is told whose it is, so the agent knows what a publish may use.
    expect(await opened.json()).toMatchObject({ role: 'edit', repo: 't-recipes', addedTo: 'ada' });
    // His workspace in his own account has nothing to do with it.
    expect((await open({})).status).toBe(403);
    // What he pushes is published in Ada's account, held to what the project already has there.
    const claim = await runtimeDeploymentClaimAction({
      request: await bo.runtime('/api/cloudflare/runtime-projects/deployments/claim', {
        body: JSON.stringify({ orgProjectId: RECIPES, branch: 'main', commit: COMMIT }),
        in: 'ada',
      }),
      env,
    });
    expect(claim.status).toBe(200);
    expect(claimedSchema.parse(await claim.json()).restricted).toBe(true);
    const pushed = await runtimeMainPushedAction({
      request: await bo.runtime('/api/cloudflare/runtime-projects/main-pushed', {
        body: JSON.stringify({ orgProjectId: RECIPES, oldCommit: null, newCommit: COMMIT }),
        in: 'ada',
      }),
      env,
    });
    expect(pushed.status).toBe(200);
  });

  it('records no push of main for someone who may only view the project', async () => {
    const { env, db, ada, bo, share } = await world();
    await share(ada, 'bo', 'view');
    const pushed = await runtimeMainPushedAction({
      request: await bo.runtime('/api/cloudflare/runtime-projects/main-pushed', {
        body: JSON.stringify({ orgProjectId: RECIPES, oldCommit: null, newCommit: COMMIT }),
        in: 'ada',
      }),
      env,
    });
    expect(pushed.status).toBe(403);
    const pushes = await db.prepare('SELECT COUNT(*) AS count FROM project_main_pushes').first<{ count: number }>();
    expect(pushes?.count).toBe(0);
  });

  it('takes someone off at their next call, and out of the account once they have no project left in it', async () => {
    const { env, db, database, ada, bo, share, sharing } = await world();
    const notes = '66666666-6666-4666-8666-666666666666';
    database
      .prepare(
        `INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, deploys_with, created_by,
           created_at) VALUES (?, 'ada-own', 'Notes', 'notes', 't-notes', 'chat', 'cloudchef', ?, 1)`,
      )
      .run(notes, ada.userId);
    await share(ada, 'bo', 'edit');
    await addProjectShareAction({
      request: ada.browser(`/api/projects/${notes}/sharing/add`, { to: 'bo', role: 'view' }),
      env,
    });
    const open = async (projectId: string) =>
      (
        await runtimeOpenProjectAction({
          request: await bo.runtime('/api/cloudflare/runtime-projects/open', {
            body: JSON.stringify({ orgProjectId: projectId }),
            in: 'ada',
          }),
          env,
          app: null,
        })
      ).status;
    const remove = (path: string) =>
      setProjectPersonAction({ request: ada.browser(`${path}/person`, { userId: bo.userId, role: null }), env });
    const inAdasAccount = async () =>
      (await listWorkspaceContexts(db, bo.userId)).some((context) => context.connectionId === 'ada-own');

    // Off one project: refused there at once, and still at work on the other.
    await remove(sharing);
    expect(await open(RECIPES)).toBe(403);
    expect(await open(notes)).toBe(200);
    expect(await inAdasAccount()).toBe(true);
    // Off the last: nothing of Ada's account is his to open.
    await remove(`/api/projects/${notes}/sharing`);
    expect(await open(notes)).toBe(401);
    expect(await inAdasAccount()).toBe(false);
    // Added again, he is back, with nothing else changed.
    await share(ada, 'bo', 'view');
    expect(await open(RECIPES)).toBe(200);
  });

  it('lets another account read a project only through CloudChef, never push to it, and only while they may read it', async () => {
    const { env, ada, bo, share, sharing } = await world();
    await share(ada, 'bo', 'edit');
    const forwarded: { url: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        forwarded.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
        return new Response('ok');
      }),
    );
    const ask = async (op: string, method = 'GET', search = '') =>
      (
        await runtimeSharedAction({
          request: await bo.runtime(`/api/cloudflare/runtime-shared/${RECIPES}/${op}${search}`, {
            method,
            headers: { 'x-cloudchef-workspace': 'ws1' },
            body: method === 'POST' ? 'pack' : undefined,
          }),
          env,
        })
      ).status;

    // From his own account Bo reads it through Ada's runtime, with a capability naming him and the project, to read.
    expect(await ask('head')).toBe(200);
    expect(await ask('git/info/refs', 'GET', '?service=git-upload-pack')).toBe(200);
    expect(forwarded.map((call) => new URL(call.url).origin)).toEqual([
      'https://ada.runtime.test',
      'https://ada.runtime.test',
    ]);
    const token = forwarded[0]!.authorization!.slice('Bearer '.length);
    const payload = capabilitySchema.parse(
      JSON.parse(atob(token.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'))),
    );
    expect(readSharedCapabilitySubject(payload.subject)).toEqual({
      projectId: RECIPES,
      role: 'view',
      userId: bo.userId,
    });

    // A push never goes this way, even for someone who may edit it: he pushes from his workspace in Ada's account.
    expect(await ask('git/git-receive-pack', 'POST')).toBe(403);
    expect(await ask('git/info/refs', 'GET', '?service=git-receive-pack')).toBe(403);
    expect(forwarded).toHaveLength(2);

    // Removed: refused at the very next request, before anything reaches Ada's runtime.
    await setProjectPersonAction({ request: ada.browser(`${sharing}/person`, { userId: bo.userId, role: null }), env });
    expect(await ask('head')).toBe(403);
    expect(forwarded).toHaveLength(2);
  });

  it('reads a project of the runtime’s own account through CloudChef, but refuses pushing to it, one not shared, or an unknown request', async () => {
    const { env, ada, bo } = await world();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    // Ada's own project, read in her own account: a read goes through, as one of a team project she may only view would.
    const own = await runtimeSharedAction({
      request: await ada.runtime(`/api/cloudflare/runtime-shared/${RECIPES}/head`, {
        method: 'GET',
        headers: { 'x-cloudchef-workspace': 'ws1' },
      }),
      env,
    });
    expect(own.status).toBe(200);
    // A push to a project of her own account: her runtime pushes to it itself.
    const ownPush = await runtimeSharedAction({
      request: await ada.runtime(`/api/cloudflare/runtime-shared/${RECIPES}/git/git-receive-pack`, {
        method: 'POST',
        body: 'pack',
        headers: { 'x-cloudchef-workspace': 'ws1' },
      }),
      env,
    });
    expect(ownPush.status).toBe(403);
    const notShared = await runtimeSharedAction({
      request: await bo.runtime(`/api/cloudflare/runtime-shared/${RECIPES}/head`, {
        method: 'GET',
        headers: { 'x-cloudchef-workspace': 'ws1' },
      }),
      env,
    });
    expect(notShared.status).toBe(403);
    const unknown = await runtimeSharedAction({
      request: await bo.runtime(`/api/cloudflare/runtime-shared/${RECIPES}/refs`, { method: 'GET' }),
      env,
    });
    expect(unknown.status).toBe(404);
    // Without the runtime's secret, nothing is answered.
    const forged = await runtimeSharedAction({
      request: new Request(`${ORIGIN}/api/cloudflare/runtime-shared/${RECIPES}/head`, {
        headers: runtimeIdentityHeaders({ userId: bo.userId, connectionId: bo.connection, connectionGeneration: 1 }),
      }),
      env,
    });
    expect(forged.status).toBe(401);
  });
});

describe('a role left behind', () => {
  it('gives nothing to someone paused in the project’s account, or no longer in it', async () => {
    const { database, db, ada, bo, cy, share } = await world();
    await share(ada, 'bo', 'edit');
    await share(ada, 'cy', 'edit');
    database.prepare(`UPDATE organization_members SET paused_at = 2 WHERE user_id = ?`).run(bo.userId);
    database.prepare(`DELETE FROM organization_members WHERE org_id = 'ada-own' AND user_id = ?`).run(cy.userId);
    expect(await findAccessibleProject(db, RECIPES, bo.userId)).toBeNull();
    expect(await findAccessibleProject(db, RECIPES, cy.userId)).toBeNull();
    expect(await findAccessibleProject(db, RECIPES, ada.userId)).toMatchObject({ role: 'edit' });
    // Shared with again, someone paused is at work again: whoever runs the project just chose them.
    await share(ada, 'bo', 'view');
    expect(await findAccessibleProject(db, RECIPES, bo.userId)).toMatchObject({ role: 'view' });
    // Never an admin who was paused: one project shared doesn't put them back in charge of the account.
    database
      .prepare(
        `INSERT INTO organization_members (org_id, user_id, role, joined_at, paused_at) VALUES ('ada-own', ?, 'admin', 1, 2)`,
      )
      .run(cy.userId);
    await share(ada, 'cy', 'edit');
    expect(await findAccessibleProject(db, RECIPES, cy.userId)).toBeNull();
  });
});

describe('an invitation by email', () => {
  it('is taken only by someone signed in with the address it was sent to', async () => {
    const { env, db, ada, bo, share, tokenOf } = await world();
    await share(ada, 'sara@example.com', 'edit');
    const token = tokenOf('sara@example.com')!;
    const described = await describeProjectInvitationAction({
      request: new Request(`${ORIGIN}/api/project-invitations/describe`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
      env,
    });
    expect(await described.json()).toEqual({
      projectName: 'Recipe Box',
      inviterName: 'ada',
      email: 'sara@example.com',
      role: 'edit',
    });
    // Bo has the link, but it isn't his address.
    const wrong = await acceptProjectInvitationAction({
      request: bo.browser('/api/project-invitations/accept', { token }),
      env,
    });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ code: 'email_mismatch' });
    expect(await findAccessibleProject(db, RECIPES, bo.userId)).toBeNull();

    // Sara signs up with that address and takes it; the link is then spent.
    const sara = await createProvenEmailUser(db, 'sara@example.com');
    const cookie = (await createAuthSession(env, sara.id, new Request(`${ORIGIN}/`))).cookie.split(';')[0]!;
    const accept = () =>
      acceptProjectInvitationAction({
        request: new Request(`${ORIGIN}/api/project-invitations/accept`, {
          method: 'POST',
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
          body: JSON.stringify({ token }),
        }),
        env,
      });
    const taken = await accept();
    expect(taken.status).toBe(200);
    expect(await taken.json()).toEqual({ projectId: RECIPES });
    expect(await findAccessibleProject(db, RECIPES, sara.id)).toMatchObject({ role: 'edit' });
    // She has no Cloudflare account, and needs none: her session works in Ada's, where the project is.
    const session = await getAuthSession(env, new Request(`${ORIGIN}/`, { headers: { cookie } }));
    expect(session?.context).toMatchObject({ connectionId: 'ada-own', role: 'member', draftsAllowed: false });
    expect((await accept()).status).toBe(410);
  });

  it('is refused once expired, cancelled, or once its sender no longer runs the project', async () => {
    const { env, db, database, ada, bo, cy, share, tokenOf, sharing } = await world();
    await share(ada, 'cy@example.com', 'edit');
    const accept = (token: string) =>
      acceptProjectInvitationAction({ request: cy.browser('/api/project-invitations/accept', { token }), env });

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + PROJECT_INVITATION_TTL_MS + 1 });
    expect((await accept(tokenOf('cy@example.com')!)).status).toBe(410);
    expect(await acceptInvitationsForUser(db, cy.userId)).toBe(0);
    vi.useRealTimers();

    // Sent again: a new link, and the old one no longer works.
    const first = tokenOf('cy@example.com')!;
    const listed = sharingSchema.parse(
      await (await projectSharingAction({ request: ada.browser(sharing), env })).json(),
    );
    const id = listed.invitations[0]!.id;
    await setProjectInvitationAction({
      request: ada.browser(`${sharing}/invitation`, { invitationId: id, resend: true }),
      env,
    });
    const second = tokenOf('cy@example.com')!;
    expect(second).not.toBe(first);
    expect((await accept(first)).status).toBe(410);

    // Cancelled: refused.
    await setProjectInvitationAction({
      request: ada.browser(`${sharing}/invitation`, { invitationId: id, role: null }),
      env,
    });
    expect((await accept(second)).status).toBe(410);

    // Sent by someone who doesn't run the project (an admin since removed, say): it can't be taken.
    await share(ada, 'cy@example.com', 'view');
    database.prepare('UPDATE project_invitations SET invited_by = ?').run(bo.userId);
    expect((await accept(tokenOf('cy@example.com')!)).status).toBe(410);
    expect(await findAccessibleProject(db, RECIPES, cy.userId)).toBeNull();
  });

  it('is never taken by an address only a Cloudflare login reported', async () => {
    const { env, db, database, ada, share, tokenOf } = await world();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cloudflare_subject)
        VALUES ('cf-only', 'Mallory', 'victim@example.com', 0, 1, 1, 'cf-subject');
    `);
    await share(ada, 'victim@example.com', 'edit');
    // Not told in CloudChef, and the address doesn't take it when Mallory looks.
    const told = await db.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE user_id = 'cf-only'`).first();
    expect(told).toEqual({ count: 0 });
    expect(await acceptInvitationsForUser(db, 'cf-only')).toBe(0);
    const cookie = (await createAuthSession(env, 'cf-only', new Request(`${ORIGIN}/`))).cookie.split(';')[0]!;
    const refused = await acceptProjectInvitationAction({
      request: new Request(`${ORIGIN}/api/project-invitations/accept`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ token: tokenOf('victim@example.com') }),
      }),
      env,
    });
    expect(await refused.json()).toMatchObject({ code: 'email_unproven' });
    expect(await findAccessibleProject(db, RECIPES, 'cf-only')).toBeNull();
  });
});
