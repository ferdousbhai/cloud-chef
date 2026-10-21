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
const GATEWAY_PATH = '/ai-gateway/gateways/default';
const PROVIDER_PATH = `${GATEWAY_PATH}/provider_configs`;

type GatewayValue = string | number | boolean | null;
type Gateway = Record<string, GatewayValue>;

/**
 * A real account's `default` gateway as Cloudflare answered for it: authentication on, but no Secrets
 * Store (`store_id` empty), unset rate limits and retries as null, and its own logging choices.
 */
const GATEWAY_WITHOUT_STORE: Gateway = {
  id: 'default',
  created_at: '2026-01-01T00:00:00.000Z',
  modified_at: '2026-01-02T00:00:00.000Z',
  is_default: true,
  internal: false,
  wholesale: false,
  rate_limiting_interval: null,
  rate_limiting_limit: null,
  rate_limiting_technique: null,
  cache_ttl: 0,
  log_management: 10000000,
  log_management_strategy: 'DELETE_OLDEST',
  logpush_public_key: null,
  authentication: true,
  collect_logs: true,
  cache_invalidate_on_update: false,
  logpush: false,
  byok_only: false,
  zdr: false,
  log_classification: false,
  store_id: '',
  workers_ai_billing_mode: 'postpaid',
  retry_max_attempts: null,
  retry_delay: null,
  retry_backoff: null,
};

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

type Secret = { id: string; name: string; scopes: string[]; storeId: string };

/** The admin's own Anthropic key, kept in the store under a name of their choosing. */
const ADMIN_SECRET: Secret = {
  id: 'secret-startup',
  name: 'anthropic-startup',
  scopes: ['ai_gateway', 'containers', 'workers'],
  storeId: 'store-1',
};

const gatewayWriteSchema = z.looseObject({
  cache_invalidate_on_update: z.boolean(),
  cache_ttl: z.number(),
  collect_logs: z.boolean(),
  rate_limiting_interval: z.number(),
  rate_limiting_limit: z.number(),
});
const gatewayFieldsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/**
 * The connected account's Cloudflare API, in memory: the default gateway, its provider keys, and the
 * account's Secrets Stores. Like Cloudflare, it stores a pasted provider key as the secret
 * `{gateway}_{provider}_{alias}` in the gateway's store, and only on a gateway with authentication on
 * and a store linked. It records every request so a test can see exactly what CloudChef sent.
 */
function fakeCloudflare({
  gateway: initialGateway = GATEWAY_WITHOUT_STORE,
  stores = ['store-1'],
}: { gateway?: Gateway | null; stores?: string[] } = {}) {
  let gateway = initialGateway === null ? null : { ...initialGateway };
  const providers: ProviderConfig[] = [];
  const secrets: Secret[] = [{ ...ADMIN_SECRET }];
  const requests: { method: string; path: string; body: string }[] = [];
  let nextId = 1;
  const ok = (result: object) => Response.json({ success: true, result, result_info: { total_pages: 1 } });
  const refuse = (message: string, status = 400) =>
    Response.json({ success: false, errors: [{ code: 7001, message }] }, { status });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const body = await new Request(url, init).text();
    const path = url.pathname.replace(new URL(API).pathname, '');
    requests.push({ method, path, body });
    if (path === GATEWAY_PATH && method === 'GET') {
      return gateway ? ok(gateway) : refuse('not found', 404);
    }
    if ((path === GATEWAY_PATH && method === 'PUT') || (path === '/ai-gateway/gateways' && method === 'POST')) {
      if (method === 'PUT' && !gateway) {
        return refuse('not found', 404);
      }
      const written = gatewayWriteSchema.safeParse(JSON.parse(body));
      if (!written.success) {
        return refuse('Invalid gateway settings');
      }
      gateway = {
        ...gatewayFieldsSchema.parse(written.data),
        id: 'default',
        created_at: '2026-01-01T00:00:00.000Z',
        modified_at: '2026-03-01T00:00:00.000Z',
      };
      return ok(gateway);
    }
    if (path === PROVIDER_PATH && method === 'GET') {
      return ok(providers);
    }
    if (path === PROVIDER_PATH && method === 'POST') {
      const created = z
        .strictObject({
          provider_slug: z.string(),
          alias: z.string(),
          default_config: z.boolean(),
          secret: z.string(),
        })
        .parse(JSON.parse(body));
      const name = `default_${created.provider_slug}_${created.alias}`;
      const storeId = z.string().min(1).safeParse(gateway?.store_id).data;
      if (gateway?.authentication !== true) {
        return refuse(`Secret ${name} was not found`);
      }
      if (!storeId) {
        return refuse('Gateway default does not have a Secrets Store configured');
      }
      if (secrets.some((secret) => secret.storeId === storeId && secret.name === name)) {
        return refuse(`Secret ${name} already exists`, 409);
      }
      const secret = { id: `secret-${nextId++}`, name, scopes: ['ai_gateway'], storeId };
      secrets.push(secret);
      const config = {
        id: `config-${nextId++}`,
        provider_slug: created.provider_slug,
        alias: created.alias,
        default_config: created.default_config,
        secret_id: secret.id,
        secret_preview: `${created.secret.slice(0, 4)}...${created.secret.slice(-4)}`,
        gateway_id: 'default',
      };
      providers.push(config);
      return ok(config);
    }
    if (path.startsWith(`${PROVIDER_PATH}/`) && method === 'DELETE') {
      const index = providers.findIndex(({ id }) => id === path.slice(PROVIDER_PATH.length + 1));
      providers.splice(index, 1);
      return ok({});
    }
    if (path === '/secrets_store/stores' && method === 'GET') {
      return ok(stores.map((id) => ({ id, name: id })));
    }
    const secretsPath = /^\/secrets_store\/stores\/([^/]+)\/secrets(?:\/([^/]+))?$/.exec(path);
    if (secretsPath && !secretsPath[2] && method === 'GET') {
      return ok(
        secrets
          .filter(({ storeId }) => storeId === secretsPath[1])
          .map(({ id, name, scopes }) => ({ id, name, scopes })),
      );
    }
    if (secretsPath?.[2] && method === 'DELETE') {
      const index = secrets.findIndex(({ id, storeId }) => id === secretsPath[2] && storeId === secretsPath[1]);
      if (index === -1) {
        return refuse('not found', 404);
      }
      secrets.splice(index, 1);
      return ok({});
    }
    return refuse('not found', 404);
  };
  const openAccountApi = async () => new UserCloudflareAccountApi(ACCOUNT_ID, 'oauth-token', request);
  return { providers, secrets, requests, openAccountApi, gateway: () => gateway };
}

async function setup({
  capabilities = ALL_CAPABILITIES,
  cloudflare = fakeCloudflare(),
}: { capabilities?: string[]; cloudflare?: ReturnType<typeof fakeCloudflare> } = {}) {
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
  return { database, env, admin, member, cloudflare };
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

function writesOf(cloudflare: ReturnType<typeof fakeCloudflare>) {
  return cloudflare.requests.filter(({ method }) => method !== 'GET');
}

describe('Settings: models', () => {
  it("links a pasted key without keeping it, giving a gateway without a store the account's store", async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;

    const before = await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi });
    expect(before.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await before.json()).toEqual({ canManage: true, defaultModelId: null, claude: { status: 'unlinked' } });

    const linked = await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    expect(linked.status).toBe(200);
    const linkedText = await linked.text();
    expect(linkedText).not.toContain(PASTED_KEY);
    // Authentication was already on, so nothing else that calls the gateway changes.
    expect(JSON.parse(linkedText)).toEqual({
      claude: { status: 'linked', alias: 'cloudchef', secretPreview: 'sk-a...6789' },
      authenticationTurnedOn: false,
    });

    const writes = writesOf(cloudflare);
    expect(writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `PUT ${GATEWAY_PATH}`,
      `POST ${PROVIDER_PATH}`,
    ]);
    // The gateway is written back whole, as it was, with the store linked: Cloudflare's own fields
    // left out, unset limits as the 0 it accepts, and unset optional settings left unsent.
    expect(JSON.parse(writes[0]?.body ?? '{}')).toEqual({
      cache_invalidate_on_update: false,
      cache_ttl: 0,
      collect_logs: true,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      rate_limiting_technique: 'fixed',
      log_management: 10000000,
      log_management_strategy: 'DELETE_OLDEST',
      authentication: true,
      logpush: false,
      byok_only: false,
      zdr: false,
      log_classification: false,
      store_id: 'store-1',
      workers_ai_billing_mode: 'postpaid',
    });
    // The key went to Cloudflare once, as the gateway's default Anthropic key, and nowhere else.
    expect(JSON.parse(writes[1]?.body ?? '{}')).toEqual({
      provider_slug: 'anthropic',
      alias: 'cloudchef',
      default_config: true,
      secret: PASTED_KEY,
    });
    expect(cloudflare.secrets.map(({ name }) => name)).toEqual(['anthropic-startup', 'default_anthropic_cloudchef']);
    expect(await (await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi })).json()).toMatchObject(
      { claude: { status: 'linked', alias: 'cloudchef' } },
    );
  });

  it('leaves a gateway that has a store and authentication as it is', async () => {
    const cloudflare = fakeCloudflare({ gateway: { ...GATEWAY_WITHOUT_STORE, store_id: 'store-2' } });
    const { env, admin } = await setup({ cloudflare });

    const linked = await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi: cloudflare.openAccountApi,
    });

    expect(await linked.json()).toMatchObject({ claude: { status: 'linked' }, authenticationTurnedOn: false });
    expect(writesOf(cloudflare).map(({ method, path }) => `${method} ${path}`)).toEqual([`POST ${PROVIDER_PATH}`]);
    expect(cloudflare.gateway()).toEqual({ ...GATEWAY_WITHOUT_STORE, store_id: 'store-2' });
  });

  it('turns authentication on for a gateway that had it off, keeping its store, and says so', async () => {
    const cloudflare = fakeCloudflare({
      gateway: { ...GATEWAY_WITHOUT_STORE, authentication: false, store_id: 'store-2', rate_limiting_limit: 50 },
      stores: ['store-1', 'store-2'],
    });
    const { env, admin } = await setup({ cloudflare });

    const linked = await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi: cloudflare.openAccountApi,
    });

    expect(await linked.json()).toMatchObject({ claude: { status: 'linked' }, authenticationTurnedOn: true });
    expect(cloudflare.gateway()).toMatchObject({ authentication: true, store_id: 'store-2', rate_limiting_limit: 50 });
    expect(cloudflare.secrets).toContainEqual(
      expect.objectContaining({ name: 'default_anthropic_cloudchef', storeId: 'store-2' }),
    );
  });

  it('creates the default gateway, ready for keys, when the account has none yet', async () => {
    const cloudflare = fakeCloudflare({ gateway: null });
    const { env, admin } = await setup({ cloudflare });

    const linked = await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi: cloudflare.openAccountApi,
    });

    expect(await linked.json()).toMatchObject({ claude: { status: 'linked' }, authenticationTurnedOn: true });
    const created = writesOf(cloudflare)[0];
    expect(created?.path).toBe('/ai-gateway/gateways');
    expect(JSON.parse(created?.body ?? '{}')).toEqual({
      id: 'default',
      authentication: true,
      store_id: 'store-1',
      collect_logs: true,
      cache_ttl: 0,
      cache_invalidate_on_update: false,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      rate_limiting_technique: 'fixed',
    });
  });

  it('refuses an account without a Secrets Store, changing nothing', async () => {
    const cloudflare = fakeCloudflare({ stores: [] });
    const { env, admin } = await setup({ cloudflare });

    const linked = await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi: cloudflare.openAccountApi,
    });

    expect(linked.status).toBe(400);
    expect(await linked.json()).toEqual({ error: expect.stringContaining('no Secrets Store') });
    expect(writesOf(cloudflare)).toEqual([]);
  });

  it("relinks by deleting CloudChef's previous key and its secret, never the admin's own secret", async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    const link = (apiKey: string) =>
      linkClaudeKeyAction({ request: post(admin.cookie, '/claude/link', { apiKey }), env, openAccountApi });
    await link(PASTED_KEY);
    const firstSecret = cloudflare.secrets.find(({ name }) => name === 'default_anthropic_cloudchef');

    const relinked = await link('sk-ant-api03-a-second-test-key-9876543210');

    expect(await relinked.json()).toMatchObject({ claude: { status: 'linked', secretPreview: 'sk-a...3210' } });
    expect(cloudflare.providers).toEqual([expect.objectContaining({ provider_slug: 'anthropic', alias: 'cloudchef' })]);
    expect(
      writesOf(cloudflare)
        .filter(({ method }) => method === 'DELETE')
        .map(({ path }) => path),
    ).toEqual([`${PROVIDER_PATH}/config-2`, `/secrets_store/stores/store-1/secrets/${firstSecret?.id}`]);
    expect(cloudflare.secrets).toEqual([
      ADMIN_SECRET,
      expect.objectContaining({ name: 'default_anthropic_cloudchef', storeId: 'store-1' }),
    ]);
  });

  it("unlinks the key and deletes its secret, leaving the admin's own, after which the runtime has no Claude", async () => {
    const { env, admin, cloudflare, database } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    await linkClaudeKeyAction({
      request: post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    const connection = connectionOf(database);
    expect(await isClaudeLinked(env, connection, openAccountApi)).toBe(true);
    const gatewayLinked = cloudflare.gateway();

    const unlinked = await unlinkClaudeKeyAction({
      request: post(admin.cookie, '/claude/unlink', {}),
      env,
      openAccountApi,
    });

    expect(await unlinked.json()).toEqual({ claude: { status: 'unlinked' } });
    expect(cloudflare.providers).toEqual([]);
    expect(cloudflare.secrets).toEqual([ADMIN_SECRET]);
    expect(cloudflare.gateway()).toEqual(gatewayLinked);
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
    expect(writesOf(cloudflare)).toEqual([]);
  });

  it('asks for a reauthorization when the connection predates AI Gateway keys, without calling Cloudflare', async () => {
    const { env, admin, cloudflare } = await setup({ capabilities: ALL_CAPABILITIES.slice(0, -1) });
    const openAccountApi = cloudflare.openAccountApi;

    expect(await (await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi })).json()).toMatchObject(
      { claude: { status: 'reauthorization_required' } },
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

  it('refuses another origin, no session, and a request that is not a pasted key', async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;

    expect((await modelSettingsAction({ request: get(''), env, openAccountApi })).status).toBe(401);
    const evil = post(admin.cookie, '/claude/link', { apiKey: PASTED_KEY }, 'https://evil.example');
    expect((await linkClaudeKeyAction({ request: evil, env, openAccountApi })).status).toBe(403);
    // An existing Secrets Store secret cannot be linked: Cloudflare's provider keys do not find one.
    const invalid: Record<string, string>[] = [
      {},
      { apiKey: 'short' },
      { secretId: 'secret-startup' },
      { apiKey: PASTED_KEY, secretId: 'secret-startup' },
    ];
    for (const body of invalid) {
      const response = await linkClaudeKeyAction({
        request: post(admin.cookie, '/claude/link', body),
        env,
        openAccountApi,
      });
      expect(response.status).toBe(400);
    }
    expect(cloudflare.requests).toEqual([]);
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
