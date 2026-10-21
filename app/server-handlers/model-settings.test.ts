import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { createAuthSession, prepareAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import { createOrganization } from '~/lib/cloudflare/data/organizations.server';
import { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import { isClaudeLinked } from '~/lib/.server/cloudflare/ai-gateway-claude';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import {
  linkClaudeKeyAction,
  modelSettingsAction,
  unlinkClaudeKeyAction,
  updateDefaultModelAction,
} from './model-settings';
import { runtimeModelsAction } from './runtime-credential';

const ORIGIN = 'https://cloudchef.build';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
const PASTED_KEY = 'sk-ant-api03-this-is-a-test-key-0123456789';
const ENCRYPTION_KEY = btoa('a'.repeat(32));
const ALL_CAPABILITIES = [
  'workers',
  'containers',
  'd1',
  'r2',
  'kv',
  'durable_objects',
  'workers_ai',
  'ai_gateway_keys',
];

/** A provider key on the fake account's gateway, in Cloudflare's own shape. */
type ProviderConfig = {
  id: string;
  provider_slug: string;
  alias: string;
  default_config: boolean;
  secret_id: string;
  secret_preview: string;
  gateway_id: string;
};

/** What the fake Cloudflare API answers with, inside its usual envelope. */
type FakeResult =
  | ProviderConfig
  | readonly ProviderConfig[]
  | readonly { id: string; name: string; scopes?: string[] }[]
  | Record<string, never>;

/**
 * The connected account's Cloudflare API, in memory: the default gateway's provider keys and one
 * Secrets Store. It records every request so a test can see exactly what CloudChef sent.
 */
function fakeCloudflare() {
  const providers: ProviderConfig[] = [];
  const requests: { method: string; path: string; body: string }[] = [];
  const secrets = [
    { id: 'secret-team', name: 'default_anthropic_team', scopes: ['ai_gateway'] },
    { id: 'secret-misnamed', name: 'anthropic-key', scopes: ['ai_gateway'] },
    { id: 'secret-workers', name: 'default_anthropic_workers', scopes: ['workers'] },
  ];
  let nextId = 1;
  const ok = (result: FakeResult) => Response.json({ success: true, result, result_info: { total_pages: 1 } });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const body = await new Request(url, init).text();
    const path = url.pathname.replace(new URL(API).pathname, '');
    requests.push({ method, path, body });
    const providerPath = '/ai-gateway/gateways/default/provider_configs';
    if (path === providerPath && method === 'GET') {
      return ok(providers);
    }
    if (path === providerPath && method === 'POST') {
      const created = z
        .object({
          provider_slug: z.string(),
          alias: z.string(),
          default_config: z.boolean(),
          secret: z.string().optional(),
          secret_id: z.string().optional(),
        })
        .parse(JSON.parse(body));
      const config = {
        id: `config-${nextId++}`,
        provider_slug: created.provider_slug,
        alias: created.alias,
        default_config: created.default_config,
        secret_id: created.secret_id ?? 'secret-stored',
        secret_preview: created.secret ? `${created.secret.slice(0, 4)}...${created.secret.slice(-4)}` : 'sk-a...team',
        gateway_id: 'default',
      };
      providers.push(config);
      return ok(config);
    }
    if (path.startsWith(`${providerPath}/`) && method === 'DELETE') {
      const index = providers.findIndex(({ id }) => id === path.slice(providerPath.length + 1));
      providers.splice(index, 1);
      return ok({});
    }
    if (path === '/secrets_store/stores') {
      return ok([{ id: 'store-1', name: 'default_secrets_store' }]);
    }
    if (path === '/secrets_store/stores/store-1/secrets') {
      return ok(secrets);
    }
    return Response.json({ success: false, errors: [{ message: 'not found' }] }, { status: 404 });
  };
  const openAccountApi = async () => new UserCloudflareAccountApi(ACCOUNT_ID, 'oauth-token', request);
  return { providers, requests, openAccountApi };
}

async function setup({ capabilities = ALL_CAPABILITIES } = {}) {
  const { database, db } = controlPlaneDatabase();
  const env = envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY });
  const signIn = async (email: string) => {
    const user = await upsertVerifiedEmailUser(db, { email });
    const cookie = (await createAuthSession(env, await prepareAuthSession(user.id))).split(';')[0] ?? '';
    return { userId: user.id, cookie };
  };
  const admin = await signIn('ada@acme.com');
  const member = await signIn('sam@acme.com');
  const orgId = await createOrganization(db, admin.userId, 'Acme');
  database
    .prepare(
      `INSERT INTO organization_members (org_id, user_id, role, joined_at, drafts_allowed) VALUES (?, ?, 'member', 1, 1)`,
    )
    .run(orgId, member.userId);
  database.exec(
    `INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, key_version, created_at)
     VALUES ('credential-1', 'x', 'y', 1, 1)`,
  );
  database
    .prepare(
      `INSERT INTO cloudflare_connections (id, org_id, account_id, account_name, status, credential_handle,
         granted_capabilities_json, created_at, updated_at)
       VALUES ('acme-connection', ?, ?, 'Acme', 'active', 'credential-1', ?, 1, 1)`,
    )
    .run(orgId, ACCOUNT_ID, JSON.stringify(capabilities));
  return { database, env, admin, member, cloudflare: fakeCloudflare() };
}

function get(cookie: string): Request {
  return new Request(`${ORIGIN}/api/settings/models`, { headers: { cookie } });
}

function post(cookie: string, path: string, body: Record<string, string | null>, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/settings/models${path}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

describe('Settings: models', () => {
  it("lists the account's AI Gateway secrets to an admin, and links a pasted key without keeping it", async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;

    const before = await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi });
    expect(before.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await before.json()).toEqual({
      canManage: true,
      defaultModelId: null,
      claude: { status: 'unlinked' },
      // Only secrets AI Gateway may use, each with the alias its name links under (or none).
      secrets: [
        { id: 'secret-team', name: 'default_anthropic_team', alias: 'team' },
        { id: 'secret-misnamed', name: 'anthropic-key', alias: null },
      ],
    });

    const linked = await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    expect(linked.status).toBe(200);
    const linkedText = await linked.text();
    expect(linkedText).not.toContain(PASTED_KEY);
    expect(JSON.parse(linkedText)).toEqual({
      claude: { status: 'linked', alias: 'default', secretPreview: 'sk-a...6789' },
    });

    // The key went to Cloudflare once, as the gateway's default Anthropic key, and nowhere else.
    const writes = cloudflare.requests.filter(({ method }) => method !== 'GET');
    expect(writes).toEqual([
      { method: 'POST', path: '/ai-gateway/gateways/default/provider_configs', body: expect.any(String) },
    ]);
    expect(JSON.parse(writes[0]?.body ?? '{}')).toEqual({
      provider_slug: 'anthropic',
      alias: 'default',
      default_config: true,
      secret: PASTED_KEY,
    });
    expect(await (await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi })).json()).toMatchObject(
      {
        claude: { status: 'linked', alias: 'default' },
      },
    );
  });

  it('links an existing secret by name convention, replacing the key linked before', async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });

    const linked = await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { secretId: 'secret-team' }),
      env,
      openAccountApi,
    });

    expect(await linked.json()).toEqual({ claude: { status: 'linked', alias: 'team', secretPreview: 'sk-a...team' } });
    expect(cloudflare.providers).toEqual([
      expect.objectContaining({ provider_slug: 'anthropic', alias: 'team', secret_id: 'secret-team' }),
    ]);
    expect(JSON.parse(cloudflare.requests.filter(({ method }) => method === 'POST').at(-1)?.body ?? '{}')).toEqual({
      provider_slug: 'anthropic',
      alias: 'team',
      default_config: true,
      secret_id: 'secret-team',
    });
  });

  it('refuses a secret AI Gateway could not find by name, or one it may not use', async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;

    for (const secretId of ['secret-misnamed', 'secret-workers', 'secret-missing']) {
      const response = await linkClaudeKeyAction({
        request: post(admin.cookie, '/claude/link', { secretId }),
        env,
        openAccountApi,
      });
      expect(response.status).toBe(400);
    }
    expect(cloudflare.providers).toEqual([]);
  });

  it('unlinks the key, after which Claude is not linked for the runtime either', async () => {
    const { env, admin, cloudflare, database } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    const connection = connectionOf(database);
    expect(await isClaudeLinked(env, connection, openAccountApi)).toBe(true);

    const unlinked = await unlinkClaudeKeyAction({
      request: post(admin.cookie, '/claude/unlink', {}),
      env,
      openAccountApi,
    });

    expect(await unlinked.json()).toEqual({ claude: { status: 'unlinked' } });
    expect(cloudflare.providers).toEqual([]);
    expect(await isClaudeLinked(env, connection, openAccountApi)).toBe(false);
  });

  it("leaves the gateway's other providers' keys alone, and does not read them as Claude", async () => {
    const { env, admin, cloudflare, database } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    const openAiKey = {
      id: 'config-openai',
      provider_slug: 'openai',
      alias: 'default',
      default_config: true,
      secret_id: 'secret-openai',
      secret_preview: 'sk-p...abcd',
      gateway_id: 'default',
    };
    cloudflare.providers.push(openAiKey);

    expect(await (await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi })).json()).toMatchObject(
      {
        claude: { status: 'unlinked' },
      },
    );
    expect(await isClaudeLinked(env, connectionOf(database), openAccountApi)).toBe(false);
    await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    await unlinkClaudeKeyAction({ request: post(admin.cookie, '/claude/unlink', {}), env, openAccountApi });

    expect(cloudflare.providers).toEqual([openAiKey]);
  });

  it('never reports Claude linked for a connection whose authorization cannot ask', async () => {
    const { env, admin, cloudflare, database } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    const requestsBefore = cloudflare.requests.length;

    const withoutGrant = { ...connectionOf(database), grantedCapabilities: ALL_CAPABILITIES.slice(0, -1) };
    expect(await isClaudeLinked(env, withoutGrant, openAccountApi)).toBe(false);
    expect(cloudflare.requests).toHaveLength(requestsBefore);
    // Cloudflare unreachable: also a no.
    const unreachable = async () => Promise.reject(new Error('unreachable'));
    expect(await isClaudeLinked(env, connectionOf(database), unreachable)).toBe(false);
  });

  it('shows a member the setting but lets only an admin change it', async () => {
    const { env, member, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;

    expect(await (await modelSettingsAction({ request: get(member.cookie), env, openAccountApi })).json()).toEqual({
      canManage: false,
      defaultModelId: null,
      claude: { status: 'unlinked' },
      secrets: [],
    });
    const attempts = [
      linkClaudeKeyAction({
        request: post(member.cookie, '/claude/link', { apiKey: PASTED_KEY }),
        env,
        openAccountApi,
      }),
      unlinkClaudeKeyAction({ request: post(member.cookie, '/claude/unlink', {}), env, openAccountApi }),
      updateDefaultModelAction({ request: post(member.cookie, '/default', { modelId: 'claude-opus-5-5' }), env }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(403);
    }
    expect(cloudflare.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  });

  it('asks for a reauthorization when the connection predates AI Gateway keys, without calling Cloudflare', async () => {
    const { env, admin, cloudflare } = await setup({ capabilities: ALL_CAPABILITIES.slice(0, -1) });
    const openAccountApi = cloudflare.openAccountApi;

    expect(await (await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi })).json()).toMatchObject(
      {
        claude: { status: 'reauthorization_required' },
        secrets: [],
      },
    );
    const link = await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    expect(link.status).toBe(409);
    expect(await link.json()).toMatchObject({ code: 'cloudflare_reauthorization_required' });
    expect(cloudflare.requests).toEqual([]);
  });

  it('refuses another origin, no session, and a request that is neither a secret nor a key', async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;

    expect((await modelSettingsAction({ request: get(''), env, openAccountApi })).status).toBe(401);
    const evil = post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }, 'https://evil.example');
    expect((await linkClaudeKeyAction({ request: evil, env, openAccountApi })).status).toBe(403);
    const invalid: Record<string, string>[] = [
      {},
      { apiKey: 'short' },
      { apiKey: PASTED_KEY, secretId: 'secret-team' },
    ];
    for (const body of invalid) {
      const response = await linkClaudeKeyAction({
        request: post(admin.cookie, '/claude/link', body),
        env,
        openAccountApi,
      });
      expect(response.status).toBe(400);
    }
    expect(cloudflare.providers).toEqual([]);
  });
});

describe("the team's default model", () => {
  it('is set by an admin, cleared with null, and refuses what is not a model id', async () => {
    const { env, admin, database } = await setup();

    const chosen = await updateDefaultModelAction({
      request: post(admin.cookie, '/default', { modelId: 'claude-opus-5-5' }),
      env,
    });
    expect(await chosen.json()).toEqual({ defaultModelId: 'claude-opus-5-5' });
    expect(database.prepare('SELECT default_builder_model AS model FROM cloudflare_connections').get()).toEqual({
      model: 'claude-opus-5-5',
    });

    for (const modelId of ['gpt-4', '@cf/../x', '']) {
      expect(
        (await updateDefaultModelAction({ request: post(admin.cookie, '/default', { modelId }), env })).status,
      ).toBe(400);
    }
    const cleared = await updateDefaultModelAction({ request: post(admin.cookie, '/default', { modelId: null }), env });
    expect(await cleared.json()).toEqual({ defaultModelId: null });
  });

  it("reaches the member's runtime with whether Claude is linked, for its catalog", async () => {
    const { env, admin, member, database } = await setup();
    await updateDefaultModelAction({ request: post(admin.cookie, '/default', { modelId: 'claude-opus-5-5' }), env });
    const secret = await deriveUserWorkspaceRuntimeSecret({
      encryptionKeyBase64: ENCRYPTION_KEY,
      userId: member.userId,
      accountId: ACCOUNT_ID,
      connectionGeneration: 1,
      organizationConnectionId: 'acme-connection',
    });
    const ask = (claude: boolean, bearer = secret) =>
      runtimeModelsAction({
        request: new Request(`${ORIGIN}/api/cloudflare/runtime-models`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify({ userId: member.userId, connectionId: 'acme-connection', connectionGeneration: 1 }),
        }),
        env,
        claudeLinked: async () => claude,
      });

    expect(await (await ask(true)).json()).toEqual({ defaultModelId: 'claude-opus-5-5', claude: true });
    expect(await (await ask(false)).json()).toEqual({ defaultModelId: 'claude-opus-5-5', claude: false });
    expect((await ask(true, 'b'.repeat(43))).status).toBe(401);

    // A paused member's runtime learns nothing.
    database.prepare('UPDATE organization_members SET paused_at = 1 WHERE user_id = ?').run(member.userId);
    expect((await ask(true)).status).toBe(401);
  });
});

function connectionOf(database: ReturnType<typeof controlPlaneDatabase>['database']) {
  const row = z
    .object({ id: z.string(), account_id: z.string(), granted_capabilities_json: z.string() })
    .parse(database.prepare('SELECT id, account_id, granted_capabilities_json FROM cloudflare_connections').get());
  return {
    id: row.id,
    userId: null,
    orgId: 'org',
    accountId: row.account_id,
    accountName: 'Acme',
    status: 'active' as const,
    credentialHandle: 'credential-1',
    grantedCapabilities: z.array(z.string()).parse(JSON.parse(row.granted_capabilities_json)),
    requestedOAuthScopes: [],
    grantedOAuthScopes: [],
    oauthScopeProfileVersion: null,
    oauthScopeGrantStatus: 'core' as const,
    aiBillingEnabled: true,
    connectedAt: 1,
    updatedAt: 1,
    generation: 1,
  };
}
