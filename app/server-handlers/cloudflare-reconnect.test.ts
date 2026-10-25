import { describe, expect, it, vi } from 'vitest';
import { controlPlaneDatabase, envWith, sessionCookieSignedInBefore } from '~/test/control-plane-d1';
import { createAuthSession, getAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import type { CloudflareOAuthOrchestrator } from '~/lib/.server/cloudflare/cloudflare-oauth-orchestrator';
import {
  findCloudflareConnectionForOrganization,
  findCloudflareConnectionForUser,
} from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import {
  CORE_CLOUDFLARE_OAUTH_SCOPES,
  missingCoreOAuthScopes,
} from '~/lib/.server/cloudflare/cloudflare-oauth-scope-manifest';
import { listOutdatedUserWorkspaceRuntimes } from '~/lib/.server/cloudflare/user-workspace-runtime-repository';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { USER_WORKSPACE_SANDBOX_BASE_IMAGE } from '~/workflows/user-workspace-runtime-provisioning';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { completeCloudflareConnectionAction, startCloudflareConnectionAction } from './cloudflare-integration';

const ORIGIN = 'https://cloudchef.build';
const HOUR = 60 * 60_000;
const ORG = '33333333-3333-4333-8333-333333333333';

/** Cloudflare's side of the OAuth exchange, answering as the Cloudflare login `subject`. */
function cloudflareAs(subject: string): Pick<CloudflareOAuthOrchestrator, 'startConnection' | 'completeConnection'> {
  return {
    startConnection: vi.fn(async () => ({
      sessionId: 'provider-session',
      authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth?client_id=test',
      expiresAt: Date.now() + 60_000,
    })),
    completeConnection: vi.fn(async () => ({
      user: { subject, email: 'sam@corp.com', name: 'Sam', picture: null },
      accountId: 'account-1',
      accountName: 'Sam',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: Date.now() + HOUR,
      grantedOAuthScopes: ['workers-scripts.write'],
    })),
  };
}

async function setup() {
  const { database, db } = controlPlaneDatabase();
  const env = envWith({
    DB: db,
    CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CLOUDFLARE_OAUTH_CLIENT_ID: 'client-1',
    CLOUDFLARE_OAUTH_CLIENT_SECRET: 'client-secret',
    CLOUDFLARE_OAUTH_START_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });
  const user = await upsertVerifiedEmailUser(db, { email: 'sam@corp.com' });
  // Signed in an hour ago: too long ago for export or erasure.
  const cookie = await sessionCookieSignedInBefore(env, user.id, HOUR);
  return { database, db, env, user, cookie };
}

/** Starts a connection while signed in, then comes back from Cloudflare as `orchestrator`'s login. */
async function connect(
  env: Env,
  cookie: string,
  orchestrator: Pick<CloudflareOAuthOrchestrator, 'startConnection' | 'completeConnection'>,
  { organizationId }: { organizationId?: string } = {},
) {
  const started = await startCloudflareConnectionAction({
    request: new Request(`${ORIGIN}/api/cloudflare/connection/start`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ callbackURL: `${ORIGIN}/settings`, organizationId }),
    }),
    env,
    orchestrator,
  });
  if (started.status !== 201) {
    return started;
  }
  const state = /cloudchef_oauth_state=([^;]+)/.exec(started.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return completeCloudflareConnectionAction({
    request: new Request(`${ORIGIN}/connect/return?state=${state}&code=code`, {
      headers: { cookie: `${cookie}; cloudchef_oauth_state=${state}` },
    }),
    env,
    orchestrator,
  });
}

describe('connecting Cloudflare while signed in', () => {
  it('counts reconnecting the Cloudflare login already on the account as a fresh sign-in', async () => {
    const { database, env, user, cookie } = await setup();
    database.prepare('UPDATE "user" SET cloudflare_subject = ? WHERE id = ?').run('cf-sam', user.id);

    const response = await connect(env, cookie, cloudflareAs('cf-sam'));
    expect(response.status).toBe(303);
    const fresh = /cloudchef_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')?.[0] ?? '';
    expect(fresh).not.toBe('');
    const session = await getAuthSession(env, new Request(ORIGIN, { headers: { cookie: fresh } }));
    expect(session?.user.id).toBe(user.id);
    expect(Date.now() - (session?.session.createdAt ?? 0)).toBeLessThan(60_000);
    // The old session is gone.
    expect(await getAuthSession(env, new Request(ORIGIN, { headers: { cookie } }))).toBeNull();
  });

  it('says the account is connected when the session ended before the return, and sends the browser to Settings', async () => {
    const { database, env, user, cookie } = await setup();
    database.prepare('UPDATE "user" SET cloudflare_subject = ? WHERE id = ?').run('cf-sam', user.id);
    const orchestrator = cloudflareAs('cf-sam');
    const started = await startCloudflareConnectionAction({
      request: new Request(`${ORIGIN}/api/cloudflare/connection/start`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ callbackURL: `${ORIGIN}/chat/project-1` }),
      }),
      env,
      orchestrator,
    });
    const state = /cloudchef_oauth_state=([^;]+)/.exec(started.headers.get('set-cookie') ?? '')?.[1] ?? '';

    // Back from Cloudflare with only the authorization's browser state: the session cookie is gone.
    const response = await completeCloudflareConnectionAction({
      request: new Request(`${ORIGIN}/connect/return?state=${state}&code=code`, {
        headers: { cookie: `cloudchef_oauth_state=${state}` },
      }),
      env,
      orchestrator,
    });

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/settings');
    expect(location.searchParams.get('continue')).toBe('/chat/project-1');
    expect(location.searchParams.get('cloudflare_message')).toBe('session_ended');
    expect(response.headers.get('set-cookie')).not.toContain('cloudchef_session=');
    expect(database.prepare('SELECT status FROM cloudflare_connections WHERE user_id = ?').get(user.id)).toEqual({
      status: 'active',
    });
  });

  it('asks for a recent sign-in before attaching a new Cloudflare login, and never issues a session for one', async () => {
    const { env, cookie } = await setup();
    const refused = await connect(env, cookie, cloudflareAs('cf-new'));
    expect(refused.status).toBe(401);
  });

  it("names a Cloudflare login that is someone else's by a code, not by the error's own words", async () => {
    const { database, db, env, user } = await setup();
    const other = await upsertVerifiedEmailUser(db, { email: 'kim@corp.com' });
    database.prepare('UPDATE "user" SET cloudflare_subject = ? WHERE id = ?').run('cf-sam', other.id);
    const recent = (await createAuthSession(env, user.id, new Request('https://cloudchef.build/'))).cookie.split(
      ';',
    )[0];

    const response = await connect(env, recent, cloudflareAs('cf-sam'));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('cloudflare_message')).toBe('login_linked_elsewhere');
  });
});

describe("one Cloudflare account shared by a person's own space and their team", () => {
  /**
   * Sam's own space and their team "Sites" both build in `account-1`, with one authorization that lacks a
   * scope CloudChef now needs; Sam (who signed in with Cloudflare) runs the team, Kim is a member of it only.
   * Each has a workspace in the team, and Sam one of their own.
   */
  async function sharedAccount() {
    const fixture = await setup();
    const { database, db, user } = fixture;
    database.prepare('UPDATE "user" SET cloudflare_subject = ? WHERE id = ?').run('cf-sam', user.id);
    const kim = await upsertVerifiedEmailUser(db, { email: 'kim@corp.com' });
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('${ORG}', 'Sites', 1, 1);
      INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at) VALUES ('old', 'x', 'y', 1);
      INSERT INTO cloudflare_connections (id, user_id, org_id, account_id, account_name, status, connected_at,
        created_at, updated_at, connection_generation) VALUES
        ('own', '${user.id}', NULL, 'account-1', 'Sam', 'active', 1, 1, 1, 5),
        ('team', NULL, '${ORG}', 'account-1', 'Sam', 'active', 1, 1, 1, 4);
      INSERT INTO cloudflare_authorizations (account_id, credential_handle, granted_oauth_scopes_json, created_at, updated_at)
        VALUES ('account-1', 'old', '["workers-scripts.write"]', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('${ORG}', '${user.id}', 'admin', 1), ('${ORG}', '${kim.id}', 'member', 1);
    `);
    const insertRuntime = database.prepare(
      `INSERT INTO user_computer_runtimes (user_id, connection_id, connection_generation, worker_name, endpoint,
         runtime_version, image_digest, protocol_version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'https://workspace.example', ?, ?, ?, 'ready', 1, 1)`,
    );
    const current = [
      USER_WORKSPACE_RUNTIME_SHA256,
      USER_WORKSPACE_SANDBOX_BASE_IMAGE,
      USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
    ] as const;
    insertRuntime.run(user.id, 'own', 5, 'sam-own', ...current);
    insertRuntime.run(user.id, 'team', 4, 'sam-team', ...current);
    insertRuntime.run(kim.id, 'team', 4, 'kim-team', ...current);
    return { ...fixture, kim };
  }

  /** Cloudflare's answer to reauthorizing `account-1` as `subject`, now with every scope CloudChef needs. */
  function reauthorizedAs(subject: string) {
    return {
      ...cloudflareAs(subject),
      completeConnection: vi.fn(async () => ({
        user: { subject, email: 'sam@corp.com', name: 'Sam', picture: null },
        accountId: 'account-1',
        accountName: 'Sam',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: Date.now() + HOUR,
        grantedOAuthScopes: [...CORE_CLOUDFLARE_OAUTH_SCOPES],
      })),
    };
  }

  it('is reauthorized once, from the team, for both spaces, and only the team space prepares its workspaces again', async () => {
    const { database, db, env, user, cookie } = await sharedAccount();
    const before = await findCloudflareConnectionForUser(db, user.id);
    expect(missingCoreOAuthScopes(before?.grantedOAuthScopes ?? [])).not.toEqual([]);

    const response = await connect(env, cookie, reauthorizedAs('cf-sam'), { organizationId: ORG });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('cloudflare_message')).toBeNull();

    const own = await findCloudflareConnectionForUser(db, user.id);
    const team = await findCloudflareConnectionForOrganization(db, ORG);
    // One authorization, now holding every scope, which both spaces read.
    expect(database.prepare('SELECT account_id FROM cloudflare_authorizations').all()).toEqual([
      { account_id: 'account-1' },
    ]);
    expect(own?.credentialHandle).toBe(team?.credentialHandle);
    expect(missingCoreOAuthScopes(own?.grantedOAuthScopes ?? [])).toEqual([]);
    expect(missingCoreOAuthScopes(team?.grantedOAuthScopes ?? [])).toEqual([]);
    // The replaced credential is gone.
    expect(database.prepare(`SELECT handle FROM cloudflare_credentials WHERE handle = 'old'`).get()).toBeUndefined();
    // Sam's own space keeps its generation, so their own workspace carries on; the team space moved on to a new
    // one, so the upgrade sweep prepares both team workspaces again before they are next opened.
    expect(own?.generation).toBe(5);
    expect(team?.generation).toBe(5);
    const outdated = await listOutdatedUserWorkspaceRuntimes(db, {
      runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
      imageDigest: USER_WORKSPACE_SANDBOX_BASE_IMAGE,
      protocolVersion: USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
    });
    expect(outdated.map((runtime) => runtime.connectionId)).toEqual(['team', 'team']);
    expect(outdated.every((runtime) => runtime.connectionGeneration === 5)).toBe(true);
  });

  it('is reauthorized from their own space for the team too', async () => {
    const { db, env, user, cookie } = await sharedAccount();

    const response = await connect(env, cookie, reauthorizedAs('cf-sam'));
    expect(response.status).toBe(303);

    const team = await findCloudflareConnectionForOrganization(db, ORG);
    expect(missingCoreOAuthScopes(team?.grantedOAuthScopes ?? [])).toEqual([]);
    expect(team?.generation).toBe(4);
    expect((await findCloudflareConnectionForUser(db, user.id))?.generation).toBe(6);
  });

  it("can't be taken over by a team member connecting their own space to it", async () => {
    const { database, db, env, kim } = await sharedAccount();
    database.prepare('UPDATE "user" SET cloudflare_subject = ? WHERE id = ?').run('cf-kim', kim.id);
    const kimCookie = (await createAuthSession(env, kim.id, new Request(ORIGIN))).cookie.split(';')[0];

    const response = await connect(env, kimCookie, reauthorizedAs('cf-kim'));
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('cloudflare_message')).toBe(
      'account_in_use',
    );
    expect(await findCloudflareConnectionForUser(db, kim.id)).toBeNull();
    expect(database.prepare('SELECT credential_handle FROM cloudflare_authorizations').all()).toEqual([
      { credential_handle: 'old' },
    ]);
  });
});
