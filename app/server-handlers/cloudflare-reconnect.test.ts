import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlPlaneDatabase, envWith, sessionCookieSignedInBefore, withStatementHook } from '~/test/control-plane-d1';
import { createAuthSession, getAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import type { CloudflareOAuthOrchestrator } from '~/lib/.server/cloudflare/cloudflare-oauth-orchestrator';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
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
import { USER_WORKSPACE_IMAGE } from '~/lib/.server/cloudflare/user-workspace-image';
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

afterEach(() => {
  vi.unstubAllGlobals();
});

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
      USER_WORKSPACE_IMAGE,
      USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
    ] as const;
    insertRuntime.run(user.id, 'own', 5, 'sam-own', ...current);
    insertRuntime.run(user.id, 'team', 4, 'sam-team', ...current);
    insertRuntime.run(kim.id, 'team', 4, 'kim-team', ...current);
    return { ...fixture, kim };
  }

  /** Cloudflare's answer to reauthorizing `account-1` as `subject`, now with every scope CloudChef needs. */
  function reauthorizedAs(subject: string, email = 'sam@corp.com') {
    return {
      ...cloudflareAs(subject),
      completeConnection: vi.fn(async () => ({
        user: { subject, email, name: 'Sam', picture: null },
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
      imageDigest: USER_WORKSPACE_IMAGE,
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

  /**
   * Gives `account-1` a stored authorization with every scope CloudChef needs and a current access token,
   * which Cloudflare answers with `apiStatus`; its handle, and every request made to Cloudflare.
   */
  async function storedAuthorization(fixture: Awaited<ReturnType<typeof sharedAccount>>, apiStatus: number) {
    const handle = await D1CloudflareCredentialVault.fromEnv(fixture.env).storeOAuthCredential({
      accessToken: 'shared-access',
      refreshToken: 'shared-refresh',
      expiresAt: Date.now() + HOUR,
    });
    fixture.database
      .prepare(
        `UPDATE cloudflare_authorizations SET credential_handle = ?, granted_oauth_scopes_json = ?
         WHERE account_id = 'account-1'`,
      )
      .run(handle, JSON.stringify(CORE_CLOUDFLARE_OAUTH_SCOPES));
    fixture.database.prepare(`DELETE FROM cloudflare_credentials WHERE handle = 'old'`).run();
    const requests = vi.fn<typeof fetch>(async () => Response.json({}, { status: apiStatus }));
    vi.stubGlobal('fetch', requests);
    return { handle, requests };
  }

  /** Kim runs the team now, and Sam is only a member: Sam's own space is one Kim doesn't run. */
  function kimRunsTheTeam({ database, user, kim }: Awaited<ReturnType<typeof sharedAccount>>) {
    database.prepare(`UPDATE organization_members SET role = 'member' WHERE user_id = ?`).run(user.id);
    database.prepare(`UPDATE organization_members SET role = 'admin' WHERE user_id = ?`).run(kim.id);
  }

  function connectMessage(response: Response): string | null {
    return new URL(response.headers.get('location') ?? '').searchParams.get('cloudflare_message');
  }

  function accountAuthorization(database: Awaited<ReturnType<typeof sharedAccount>>['database']) {
    return database.prepare('SELECT credential_handle FROM cloudflare_authorizations').all();
  }

  it("can't be taken over by a team member connecting their own space to it", async () => {
    const fixture = await sharedAccount();
    const { database, db, env, kim } = fixture;
    const { handle: working, requests } = await storedAuthorization(fixture, 200);
    database.prepare('UPDATE "user" SET cloudflare_subject = ? WHERE id = ?').run('cf-kim', kim.id);
    const kimCookie = (await createAuthSession(env, kim.id, new Request(ORIGIN))).cookie.split(';')[0];

    const response = await connect(env, kimCookie, reauthorizedAs('cf-kim'));
    expect(connectMessage(response)).toBe('account_in_use');
    expect(await findCloudflareConnectionForUser(db, kim.id)).toBeNull();
    expect(accountAuthorization(database)).toEqual([{ credential_handle: working }]);
    // Asked of Cloudflare with the token as it is: the grant every space there uses was never refreshed.
    expect(requests.mock.calls.map(([url]) => String(url))).toEqual(['https://api.cloudflare.com/client/v4/user']);
  });

  it("lets a person whose own space builds there sign in with Cloudflare, though they don't run the team", async () => {
    const fixture = await sharedAccount();
    const { database, db, env, user } = fixture;
    const { handle: working } = await storedAuthorization(fixture, 200);
    kimRunsTheTeam(fixture);

    const response = await connect(env, '', reauthorizedAs('cf-sam'));
    expect(connectMessage(response)).toBeNull();
    expect(response.headers.get('set-cookie')).toContain('cloudchef_session=');
    // Sam's own space reconnected the account it builds in, for the team there too.
    const own = await findCloudflareConnectionForUser(db, user.id);
    expect(own?.generation).toBe(6);
    expect(own?.credentialHandle).not.toBe(working);
    expect((await findCloudflareConnectionForOrganization(db, ORG))?.credentialHandle).toBe(own?.credentialHandle);
    expect(database.prepare('SELECT handle FROM cloudflare_credentials WHERE handle = ?').get(working)).toBeUndefined();
  });

  it("lets a person reconnect their own space there while signed in, though they don't run the team", async () => {
    const fixture = await sharedAccount();
    const { db, env, user, cookie } = fixture;
    await storedAuthorization(fixture, 200);
    kimRunsTheTeam(fixture);

    const response = await connect(env, cookie, reauthorizedAs('cf-sam'));
    expect(connectMessage(response)).toBeNull();
    expect((await findCloudflareConnectionForUser(db, user.id))?.generation).toBe(6);
  });

  it('refuses a first sign-in with Cloudflare into it before creating anyone', async () => {
    const fixture = await sharedAccount();
    const { database, env } = fixture;
    const { handle: working } = await storedAuthorization(fixture, 200);
    const users = database.prepare('SELECT COUNT(*) AS users FROM "user"').get();

    const response = await connect(env, '', reauthorizedAs('cf-new', 'new@corp.com'));
    expect(connectMessage(response)).toBe('account_in_use');
    expect(response.headers.get('set-cookie')).not.toContain('cloudchef_session=');
    expect(database.prepare('SELECT COUNT(*) AS users FROM "user"').get()).toEqual(users);
    expect(database.prepare(`SELECT id FROM "user" WHERE cloudflare_subject = 'cf-new'`).get()).toBeUndefined();
    expect(accountAuthorization(database)).toEqual([{ credential_handle: working }]);
  });

  it("is reconnected from the team by whoever runs it, even while it works for someone's own space there", async () => {
    const fixture = await sharedAccount();
    const { database, db, env, kim } = fixture;
    const { handle: working } = await storedAuthorization(fixture, 200);
    kimRunsTheTeam(fixture);
    const kimCookie = (await createAuthSession(env, kim.id, new Request(ORIGIN))).cookie.split(';')[0];

    const response = await connect(env, kimCookie, reauthorizedAs('cf-kim'), { organizationId: ORG });
    expect(connectMessage(response)).toBeNull();
    expect((await findCloudflareConnectionForOrganization(db, ORG))?.credentialHandle).not.toBe(working);
    expect(accountAuthorization(database)).not.toEqual([{ credential_handle: working }]);
  });

  it("can't be taken over by an admin bringing another team into it while it works for someone's own space there", async () => {
    const fixture = await sharedAccount();
    const { database, db, env, kim } = fixture;
    const { handle: working } = await storedAuthorization(fixture, 200);
    kimRunsTheTeam(fixture);
    const other = '44444444-4444-4444-8444-444444444444';
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('${other}', 'Kim''s other team', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('${other}', '${kim.id}', 'admin', 1);
    `);
    const kimCookie = (await createAuthSession(env, kim.id, new Request(ORIGIN))).cookie.split(';')[0];

    const response = await connect(env, kimCookie, reauthorizedAs('cf-kim'), { organizationId: other });
    expect(connectMessage(response)).toBe('account_in_use');
    expect(await findCloudflareConnectionForOrganization(db, other)).toBeNull();
    expect(accountAuthorization(database)).toEqual([{ credential_handle: working }]);
  });

  it('is connected by anyone once Cloudflare no longer accepts its grant', async () => {
    const fixture = await sharedAccount();
    const { database, db, env, user, kim } = fixture;
    const { handle: broken } = await storedAuthorization(fixture, 401);
    // Sam handed the team to Kim, then the grant ended: Kim's own space coming into the account replaces an
    // authorization no one can use any more, so the account isn't left with nobody able to reconnect it.
    kimRunsTheTeam(fixture);
    database.prepare('UPDATE "user" SET cloudflare_subject = ? WHERE id = ?').run('cf-kim', kim.id);
    const kimCookie = (await createAuthSession(env, kim.id, new Request(ORIGIN))).cookie.split(';')[0];

    const response = await connect(env, kimCookie, reauthorizedAs('cf-kim'));
    expect(connectMessage(response)).toBeNull();

    const own = await findCloudflareConnectionForUser(db, user.id);
    const kims = await findCloudflareConnectionForUser(db, kim.id);
    expect(own?.credentialHandle).toBe(kims?.credentialHandle);
    expect(kims?.credentialHandle).not.toBe(broken);
    // The ended credential is gone.
    expect(database.prepare('SELECT handle FROM cloudflare_credentials WHERE handle = ?').get(broken)).toBeUndefined();
  });

  it('writes nothing, and asks to connect again, when another connection into the account lands first', async () => {
    const fixture = await sharedAccount();
    const { database, db, env, cookie } = fixture;
    database.exec(
      `INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at) VALUES ('raced', 'x', 'y', 1)`,
    );
    // Someone else's connection into account-1 lands after this one read the account's authorization.
    const racing = withStatementHook(db, (query) => {
      if (query.includes('INSERT INTO cloudflare_authorizations')) {
        database.exec(`UPDATE cloudflare_authorizations SET credential_handle = 'raced'`);
      }
    });
    const credentials = () => database.prepare('SELECT handle FROM cloudflare_credentials ORDER BY handle').all();
    const before = credentials();

    const response = await connect(envWith({ ...env, DB: racing }), cookie, reauthorizedAs('cf-sam'));
    expect(connectMessage(response)).toBe('changed_meanwhile');
    expect(accountAuthorization(database)).toEqual([{ credential_handle: 'raced' }]);
    expect((await findCloudflareConnectionForOrganization(db, ORG))?.generation).toBe(4);
    // Its own new credential, which nothing names, is gone again.
    expect(credentials()).toEqual(before);
  });

  it('removes the credential it replaces when a team first connects to the account', async () => {
    const { database, db, env, cookie } = await sharedAccount();
    database.exec(`
      DELETE FROM user_computer_runtimes WHERE connection_id = 'team';
      DELETE FROM cloudflare_connections WHERE id = 'team';
    `);

    const response = await connect(env, cookie, reauthorizedAs('cf-sam'), { organizationId: ORG });
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('cloudflare_message')).toBeNull();

    const team = await findCloudflareConnectionForOrganization(db, ORG);
    expect(team?.generation).toBe(1);
    expect(team?.credentialHandle).not.toBe('old');
    expect(database.prepare(`SELECT handle FROM cloudflare_credentials WHERE handle = 'old'`).get()).toBeUndefined();
  });
});
