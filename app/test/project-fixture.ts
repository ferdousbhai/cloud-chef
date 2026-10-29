import { createAuthSession } from '~/lib/.server/auth';
import { runtimeIdentityHeaders } from '~/lib/.server/cloudflare/runtime-identity-headers';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { controlPlaneDatabase, createProvenEmailUser, envWith } from './control-plane-d1';

export const ORIGIN = 'https://cloudchef.build';
export const ORG = '33333333-3333-4333-8333-333333333333';
const ENCRYPTION_KEY = btoa('k'.repeat(32));

/** A request body as a browser or runtime sends it: flat JSON. */
export type Body = Record<string, string | number | boolean | null>;

/**
 * A team (`ORG`, its Cloudflare connection `team-connection` in `account-team`) with its admin Ada and its
 * member Sara, both signed in, and Sara's own connection `sara-own`. `runtime` calls a runtime route as one
 * of their workspace runtimes does: who it is in headers, its secret as the bearer.
 */
export async function teamFixture() {
  const { database, db } = controlPlaneDatabase();
  const env = envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY });
  const signIn = async (email: string) => {
    const user = await createProvenEmailUser(db, email);
    const cookie = (await createAuthSession(env, user.id, new Request(`${ORIGIN}/`))).cookie.split(';')[0];
    return { userId: user.id, cookie };
  };
  const admin = await signIn('ada@example.com');
  const sara = await signIn('Sara.A@example.com');
  database.exec(`
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('${ORG}', 'Sites', 1, 1);
    INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at) VALUES ('cred', 'x', 'y', 1);
    INSERT INTO cloudflare_connections (id, org_id, account_id, status, connection_generation, created_at, updated_at)
      VALUES ('team-connection', '${ORG}', 'account-team', 'active', 2, 1, 1);
    INSERT INTO cloudflare_authorizations (account_id, credential_handle, created_at, updated_at)
      VALUES ('account-team', 'cred', 1, 1), ('account-sara', 'cred', 1, 1);
  `);
  database
    .prepare(
      `INSERT INTO cloudflare_connections (id, user_id, account_id, status, connection_generation, created_at, updated_at)
       VALUES ('sara-own', ?, 'account-sara', 'active', 1, 1, 1)`,
    )
    .run(sara.userId);
  database
    .prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', 1)`)
    .run(ORG, admin.userId);
  database
    .prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'member', 1)`)
    .run(ORG, sara.userId);

  const runtime = async (
    path: string,
    body: Body,
    as: { userId?: string; connection?: 'team' | 'own' } = {},
  ): Promise<Request> => {
    const userId = as.userId ?? sara.userId;
    const own = as.connection === 'own';
    const secret = await deriveUserWorkspaceRuntimeSecret({
      encryptionKeyBase64: ENCRYPTION_KEY,
      userId,
      accountId: own ? 'account-sara' : 'account-team',
      connectionGeneration: own ? 1 : 2,
      organizationConnectionId: own ? null : 'team-connection',
    });
    return new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        ...runtimeIdentityHeaders({
          userId,
          connectionId: own ? 'sara-own' : 'team-connection',
          connectionGeneration: own ? 1 : 2,
        }),
      },
      body: JSON.stringify(body),
    });
  };
  const browser = (cookie: string, path: string, body: Body) =>
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  return { database, env, admin, sara, runtime, browser };
}
