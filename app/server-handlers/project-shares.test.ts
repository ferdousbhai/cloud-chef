import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { USER_WORKSPACE_IMAGE } from '~/lib/.server/cloudflare/user-workspace-image';
import { runtimeIdentityHeaders } from '~/lib/.server/cloudflare/runtime-identity-headers';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { createAuthSession } from '~/lib/.server/auth';
import { findAccessibleProject } from '~/lib/cloudflare/data/org-projects.server';
import { acceptInvitationsForUser, PROJECT_INVITATION_TTL_MS } from '~/lib/cloudflare/data/project-shares.server';
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
  projects: z.array(z.looseObject({ name: z.string(), role: z.string(), ownerName: z.string().nullable() })),
});
const capabilitySchema = z.looseObject({ subject: z.string() });

const sharingSchema = z.looseObject({
  people: z.array(z.looseObject({ userId: z.string(), name: z.string(), role: z.string(), kind: z.string() })),
  invitations: z.array(z.looseObject({ id: z.string(), email: z.string(), role: z.string() })),
  done: z.unknown().optional(),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * Ada's own project Recipe Box in her own account, and Bo and Cy, each with an account of their own. Every one of them
 * has a workspace runtime CloudChef can reach. Sent emails are kept.
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
    /** A request from this person's runtime in their own account, as every runtime route is called. */
    const runtime = async (path: string, init: { method?: string; body?: string; headers?: HeadersInit } = {}) => {
      const secret = await deriveUserWorkspaceRuntimeSecret({
        encryptionKeyBase64: KEY,
        userId: user.id,
        accountId: `account-${username}`,
        connectionGeneration: 1,
        organizationConnectionId: null,
      });
      return new Request(`${ORIGIN}${path}`, {
        method: init.method ?? 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          ...runtimeIdentityHeaders({ userId: user.id, connectionId: connection, connectionGeneration: 1 }),
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
    expect(listed.people.map(({ name, role, kind }) => ({ name, role, kind }))).toEqual([
      { name: 'ada', role: 'owner', kind: 'owner' },
      { name: 'bo', role: 'edit', kind: 'shared' },
    ]);
    expect(JSON.stringify(listed)).not.toContain('bo@example.com');
    // Bo is told, in CloudChef and by email.
    const told = await db
      .prepare(`SELECT kind, actor_id, project_id FROM notifications WHERE user_id = ?`)
      .bind(bo.userId)
      .all();
    expect(told.results).toEqual([{ kind: 'project_shared', actor_id: ada.userId, project_id: RECIPES }]);
    expect(emails.map((email) => email.to)).toEqual(['bo@example.com']);
    expect(await findAccessibleProject(db, RECIPES, bo.userId)).toMatchObject({ role: 'edit', shared: true });
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
    // Cy, who has proven that address, takes it as soon as she looks at her projects.
    const mine = sharedWithMeSchema.parse(
      await (await sharedWithMeAction({ request: cy.browser('/api/projects/shared'), env })).json(),
    );
    expect(mine.projects).toEqual([expect.objectContaining({ name: 'Recipe Box', role: 'view', ownerName: 'ada' })]);
    expect(await findAccessibleProject(db, RECIPES, cy.userId)).toMatchObject({ role: 'view', shared: true });
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

  it('takes access away at the next call once removed, and turns a viewer’s push away', async () => {
    const { env, ada, bo, share, sharing } = await world();
    await share(ada, 'bo', 'view');
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

    // A viewer reads, through Ada's runtime, with a capability naming Bo, the project and his role.
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

    // A viewer may not push, nor ask what a push may send.
    expect(await ask('git/git-receive-pack', 'POST')).toBe(403);
    expect(await ask('git/info/refs', 'GET', '?service=git-receive-pack')).toBe(403);

    // Removed: refused at the very next request, before anything reaches Ada's runtime.
    await setProjectPersonAction({ request: ada.browser(`${sharing}/person`, { userId: bo.userId, role: null }), env });
    const before = forwarded.length;
    expect(await ask('head')).toBe(403);
    expect(forwarded.length).toBe(before);
  });

  it('refuses a runtime asking about a project of its own account, one not shared with it, or an unknown request', async () => {
    const { env, ada, bo } = await world();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    // Ada's own project, read in her own account: her runtime reads it itself.
    const own = await runtimeSharedAction({
      request: await ada.runtime(`/api/cloudflare/runtime-shared/${RECIPES}/head`, {
        method: 'GET',
        headers: { 'x-cloudchef-workspace': 'ws1' },
      }),
      env,
    });
    expect(own.status).toBe(403);
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

  it('opens a shared project in the collaborator’s own account, but leaves publishing it to the owner’s', async () => {
    const { env, ada, bo, share } = await world();
    await share(ada, 'bo', 'edit');
    const opened = await runtimeOpenProjectAction({
      request: await bo.runtime('/api/cloudflare/runtime-projects/open', {
        body: JSON.stringify({ orgProjectId: RECIPES }),
      }),
      env,
      app: null,
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
      role: 'edit',
      inAnotherAccount: true,
      ownerName: 'ada',
      repo: 't-recipes',
    });
    // Building and deploying it happen only in Ada's account.
    const claim = await runtimeDeploymentClaimAction({
      request: await bo.runtime('/api/cloudflare/runtime-projects/deployments/claim', {
        body: JSON.stringify({ orgProjectId: RECIPES, branch: 'main', commit: COMMIT }),
      }),
      env,
    });
    expect(claim.status).toBe(403);
    // Bo's runtime can't record a push of main itself: Ada's runtime, which answered it, tells it for him.
    const own = await runtimeMainPushedAction({
      request: await bo.runtime('/api/cloudflare/runtime-projects/main-pushed', {
        body: JSON.stringify({ orgProjectId: RECIPES, oldCommit: null, newCommit: COMMIT }),
      }),
      env,
    });
    expect(own.status).toBe(403);
    const told = await runtimeMainPushedAction({
      request: await ada.runtime('/api/cloudflare/runtime-projects/main-pushed', {
        body: JSON.stringify({ orgProjectId: RECIPES, oldCommit: null, newCommit: COMMIT, pushedBy: bo.userId }),
      }),
      env,
    });
    expect(told.status).toBe(200);
  });

  it('records a push for someone only while they may still edit the project', async () => {
    const { env, db, ada, bo, cy, share } = await world();
    await share(ada, 'bo', 'view');
    const tell = async (pushedBy: string) =>
      (
        await runtimeMainPushedAction({
          request: await ada.runtime('/api/cloudflare/runtime-projects/main-pushed', {
            body: JSON.stringify({ orgProjectId: RECIPES, oldCommit: null, newCommit: COMMIT, pushedBy }),
          }),
          env,
        })
      ).status;
    expect(await tell(bo.userId)).toBe(403);
    expect(await tell(cy.userId)).toBe(403);
    const pushes = await db.prepare('SELECT COUNT(*) AS count FROM project_main_pushes').first<{ count: number }>();
    expect(pushes?.count).toBe(0);
  });
});

describe('a team project shared outside the team', () => {
  it('gives an outsider their share, and a paused member nothing, whatever a share row says', async () => {
    const { database, db, ada, bo, cy } = await world();
    const site = '55555555-5555-4555-8555-555555555555';
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('team', 'Sites', 1, 1);
      INSERT INTO cloudflare_connections (id, org_id, account_id, status, connection_generation, created_at, updated_at)
        VALUES ('team-connection', 'team', 'account-team', 'active', 1, 1, 1);
      INSERT INTO org_projects (id, connection_id, org_id, name, artifact_repo, created_from, deploys_with, created_at)
        VALUES ('${site}', 'team-connection', 'team', 'Site', 't-site', 'zip', 'cloudchef', 1);
    `);
    database
      .prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('team', ?, 'admin', 1)`)
      .run(ada.userId);
    database
      .prepare(
        `INSERT INTO organization_members (org_id, user_id, role, joined_at, paused_at) VALUES ('team', ?, 'member', 1, 2)`,
      )
      .run(cy.userId);
    const shareRow = database.prepare(
      `INSERT INTO project_shares (project_id, user_id, role, shared_by, shared_at) VALUES (?, ?, 'edit', ?, 1)`,
    );
    shareRow.run(site, bo.userId, ada.userId);
    shareRow.run(site, cy.userId, ada.userId);
    expect(await findAccessibleProject(db, site, bo.userId)).toMatchObject({ role: 'edit', shared: true });
    expect(await findAccessibleProject(db, site, cy.userId)).toBeNull();
    expect(await findAccessibleProject(db, site, ada.userId)).toMatchObject({ role: 'edit', shared: false });
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
    // She has no Cloudflare account yet: the page says opening it needs one.
    expect(await taken.json()).toEqual({ projectId: RECIPES, needsCloudflare: true });
    expect(await findAccessibleProject(db, RECIPES, sara.id)).toMatchObject({ role: 'edit', shared: true });
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
