import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { createAuthSession, prepareAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import { createOrganization } from '~/lib/cloudflare/data/organizations.server';
import { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import { linkedGatewayKeys } from '~/lib/.server/cloudflare/ai-gateway-keys';
import { GATEWAY_PROVIDER_SLUGS, type GatewayKey, type GatewayProviderSlug } from '~/lib/workers-ai-model';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { runtimeIdentityHeaders } from '~/lib/.server/cloudflare/runtime-identity-headers';
import {
  linkGatewayKeyAction,
  modelSettingsAction,
  unlinkGatewayKeyAction,
  updateDefaultModelAction,
} from './model-settings';
import { runtimeModelsAction } from './runtime-credential';

const ORIGIN = 'https://cloudchef.build';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
const PASTED_KEY = 'sk-ant-api03-this-is-a-test-key-0123456789';
/** A key the fake Cloudflare refuses to store. */
const REFUSED_KEY = 'sk-ant-api03-a-key-cloudflare-refuses-000';
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
const GATEWAY_WITHOUT_STORE = {
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
} satisfies Gateway;

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
  | Gateway
  | ProviderConfig
  | readonly ProviderConfig[]
  | readonly { id: string; name: string; scopes?: string[] }[]
  | Record<string, never>;

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
  let deletesRefused = false;
  const ok = (result: FakeResult) => Response.json({ success: true, result, result_info: { total_pages: 1 } });
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
      if (created.secret === REFUSED_KEY) {
        return refuse('The provider key is not valid');
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
      // Like Cloudflare, a new default key is its provider's only default.
      for (const other of providers) {
        if (created.default_config && other.provider_slug === created.provider_slug) {
          other.default_config = false;
        }
      }
      providers.push(config);
      return ok(config);
    }
    if (method === 'DELETE' && deletesRefused) {
      return refuse('Cloudflare is unavailable', 503);
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
  return {
    providers,
    secrets,
    requests,
    openAccountApi,
    gateway: () => gateway,
    refuseDeletes: () => {
      deletesRefused = true;
    },
  };
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
         granted_capabilities_json, created_at, updated_at, oauth_scope_grant_status)
       VALUES ('acme-connection', ?, ?, 'Acme', 'active', 'credential-1', ?, 1, 1, 'core')`,
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

/** Settings' answer for an account whose gateway holds no key CloudChef offers a provider's models for. */
const NO_KEYS = {
  status: 'ready',
  providers: GATEWAY_PROVIDER_SLUGS.map((provider) => ({ provider, key: null })),
};

/** Settings' answer with one provider's key on the gateway. */
function keysWith(
  provider: GatewayProviderSlug,
  key: { alias: string; secretPreview: string | null; addedByCloudChef: boolean },
) {
  return {
    status: 'ready',
    providers: GATEWAY_PROVIDER_SLUGS.map((candidate) => ({
      provider: candidate,
      key: candidate === provider ? key : null,
    })),
  };
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
    expect(await before.json()).toEqual({ canManage: true, defaultModelId: null, keys: NO_KEYS });

    const linked = await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    expect(linked.status).toBe(200);
    const linkedText = await linked.text();
    expect(linkedText).not.toContain(PASTED_KEY);
    // Authentication was already on, so nothing else that calls the gateway changes.
    expect(JSON.parse(linkedText)).toEqual({
      keys: keysWith('anthropic', { alias: 'cloudchef', secretPreview: 'sk-a...6789', addedByCloudChef: true }),
      authenticationTurnedOn: false,
      previousKeysRemain: false,
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
      { keys: keysWith('anthropic', { alias: 'cloudchef', secretPreview: 'sk-a...6789', addedByCloudChef: true }) },
    );
  });

  it('leaves a gateway that has a store and authentication as it is', async () => {
    const cloudflare = fakeCloudflare({ gateway: { ...GATEWAY_WITHOUT_STORE, store_id: 'store-2' } });
    const { env, admin } = await setup({ cloudflare });

    const linked = await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
      env,
      openAccountApi: cloudflare.openAccountApi,
    });

    expect(await linked.json()).toEqual({
      keys: keysWith('anthropic', { alias: 'cloudchef', secretPreview: 'sk-a...6789', addedByCloudChef: true }),
      authenticationTurnedOn: false,
      previousKeysRemain: false,
    });
    expect(writesOf(cloudflare).map(({ method, path }) => `${method} ${path}`)).toEqual([`POST ${PROVIDER_PATH}`]);
    expect(cloudflare.gateway()).toEqual({ ...GATEWAY_WITHOUT_STORE, store_id: 'store-2' });
  });

  it('turns authentication on for a gateway that had it off, keeping its store, and says so', async () => {
    const cloudflare = fakeCloudflare({
      gateway: { ...GATEWAY_WITHOUT_STORE, authentication: false, store_id: 'store-2', rate_limiting_limit: 50 },
      stores: ['store-1', 'store-2'],
    });
    const { env, admin } = await setup({ cloudflare });

    const linked = await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
      env,
      openAccountApi: cloudflare.openAccountApi,
    });

    expect(await linked.json()).toEqual({
      keys: keysWith('anthropic', { alias: 'cloudchef', secretPreview: 'sk-a...6789', addedByCloudChef: true }),
      authenticationTurnedOn: true,
      previousKeysRemain: false,
    });
    expect(cloudflare.gateway()).toMatchObject({ authentication: true, store_id: 'store-2', rate_limiting_limit: 50 });
    expect(cloudflare.secrets).toContainEqual(
      expect.objectContaining({ name: 'default_anthropic_cloudchef', storeId: 'store-2' }),
    );
  });

  it('creates the default gateway, ready for keys, when the account has none yet', async () => {
    const cloudflare = fakeCloudflare({ gateway: null });
    const { env, admin } = await setup({ cloudflare });

    const linked = await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
      env,
      openAccountApi: cloudflare.openAccountApi,
    });

    expect(await linked.json()).toEqual({
      keys: keysWith('anthropic', { alias: 'cloudchef', secretPreview: 'sk-a...6789', addedByCloudChef: true }),
      authenticationTurnedOn: true,
      previousKeysRemain: false,
    });
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

    const linked = await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
      env,
      openAccountApi: cloudflare.openAccountApi,
    });

    expect(linked.status).toBe(400);
    expect(await linked.json()).toEqual({ error: expect.stringContaining('no Secrets Store') });
    expect(writesOf(cloudflare)).toEqual([]);
  });

  it("relinks by adding the new key before deleting CloudChef's previous key and its secret, never the admin's own secret", async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    const link = (apiKey: string) =>
      linkGatewayKeyAction({
        request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey }),
        env,
        openAccountApi,
      });
    await link(PASTED_KEY);
    const firstSecret = cloudflare.secrets.find(({ name }) => name === 'default_anthropic_cloudchef');

    const relinked = await link('sk-ant-api03-a-second-test-key-9876543210');

    expect(await relinked.json()).toMatchObject({
      keys: keysWith('anthropic', { alias: 'cloudchef-2', secretPreview: 'sk-a...3210', addedByCloudChef: true }),
      previousKeysRemain: false,
    });
    expect(cloudflare.providers).toEqual([
      expect.objectContaining({ provider_slug: 'anthropic', alias: 'cloudchef-2' }),
    ]);
    expect(
      writesOf(cloudflare)
        .slice(-3)
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      `POST ${PROVIDER_PATH}`,
      `DELETE ${PROVIDER_PATH}/config-2`,
      `DELETE /secrets_store/stores/store-1/secrets/${firstSecret?.id}`,
    ]);
    expect(cloudflare.secrets).toEqual([
      ADMIN_SECRET,
      expect.objectContaining({ name: 'default_anthropic_cloudchef-2', storeId: 'store-1' }),
    ]);

    // The next replacement goes back under the first alias.
    const third = await link('sk-ant-api03-a-third-test-key-1111111111');
    expect(await third.json()).toMatchObject({
      keys: keysWith('anthropic', { alias: 'cloudchef', secretPreview: 'sk-a...1111', addedByCloudChef: true }),
    });
    expect(cloudflare.secrets.map(({ name }) => name)).toEqual(['anthropic-startup', 'default_anthropic_cloudchef']);
  });

  it('keeps the linked key when Cloudflare refuses its replacement', async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    const link = (apiKey: string) =>
      linkGatewayKeyAction({
        request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey }),
        env,
        openAccountApi,
      });
    await link(PASTED_KEY);
    const before = cloudflare.providers.map((config) => ({ ...config }));

    const refused = await link(REFUSED_KEY);

    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: 'The provider key is not valid' });
    expect(cloudflare.providers).toEqual(before);
    expect(cloudflare.secrets.map(({ name }) => name)).toEqual(['anthropic-startup', 'default_anthropic_cloudchef']);
  });

  it('reports the new key linked when the replaced one cannot be removed', async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    const link = (apiKey: string) =>
      linkGatewayKeyAction({
        request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey }),
        env,
        openAccountApi,
      });
    await link(PASTED_KEY);
    cloudflare.refuseDeletes();

    const relinked = await link('sk-ant-api03-a-second-test-key-9876543210');

    expect(relinked.status).toBe(200);
    expect(await relinked.json()).toMatchObject({
      keys: keysWith('anthropic', { alias: 'cloudchef-2', secretPreview: 'sk-a...3210', addedByCloudChef: true }),
      previousKeysRemain: true,
    });
    expect(cloudflare.providers.map(({ alias }) => alias)).toEqual(['cloudchef', 'cloudchef-2']);
  });

  it("unlinks the key and deletes its secret, leaving the admin's own, after which the runtime has no Anthropic key", async () => {
    const { env, admin, cloudflare, database } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    const connection = connectionOf(database);
    expect(await linkedGatewayKeys(env, connection, openAccountApi)).toEqual([
      { provider: 'anthropic', alias: 'cloudchef', revision: expect.stringMatching(/^config-/) },
    ]);
    const gatewayLinked = cloudflare.gateway();

    const unlinked = await unlinkGatewayKeyAction({
      request: post(admin.cookie, '/keys/unlink', { provider: 'anthropic' }),
      env,
      openAccountApi,
    });

    expect(await unlinked.json()).toEqual({ keys: NO_KEYS });
    expect(cloudflare.providers).toEqual([]);
    expect(cloudflare.secrets).toEqual([ADMIN_SECRET]);
    expect(cloudflare.gateway()).toEqual(gatewayLinked);
    expect(await linkedGatewayKeys(env, connection, openAccountApi)).toEqual([]);
  });

  it("leaves keys for providers CloudChef doesn't offer alone, and never reads them as one it does", async () => {
    const { env, admin, cloudflare, database } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    const mistralKey = {
      id: 'config-mistral',
      provider_slug: 'mistral',
      alias: 'default',
      default_config: true,
      secret_id: 'secret-mistral',
      secret_preview: 'mi-p...abcd',
      gateway_id: 'default',
    };
    cloudflare.providers.push(mistralKey);

    expect(await (await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi })).json()).toMatchObject(
      { keys: NO_KEYS },
    );
    expect(await linkedGatewayKeys(env, connectionOf(database), openAccountApi)).toEqual([]);
    await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    await unlinkGatewayKeyAction({
      request: post(admin.cookie, '/keys/unlink', { provider: 'anthropic' }),
      env,
      openAccountApi,
    });

    expect(cloudflare.providers).toEqual([mistralKey]);
  });

  it("uses a key added in Cloudflare under any alias, preferring a provider's default one, and leaves it on unlink", async () => {
    const { env, admin, cloudflare, database } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    const dashboardKey = (id: string, provider: string, alias: string, isDefault: boolean) => ({
      id,
      provider_slug: provider,
      alias,
      default_config: isDefault,
      secret_id: `secret-${id}`,
      secret_preview: `${alias.slice(0, 2)}...wxyz`,
      gateway_id: 'default',
    });
    cloudflare.providers.push(
      dashboardKey('config-sg', 'anthropic', 'sg', false),
      dashboardKey('config-old', 'openai', 'old', false),
      dashboardKey('config-main', 'openai', 'main', true),
    );

    // Each provider's key is read from the account, alias and all; nothing about it is CloudChef's.
    expect(await (await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi })).json()).toMatchObject(
      {
        keys: {
          status: 'ready',
          providers: [
            { provider: 'anthropic', key: { alias: 'sg', secretPreview: 'sg...wxyz', addedByCloudChef: false } },
            { provider: 'openai', key: { alias: 'main', secretPreview: 'ma...wxyz', addedByCloudChef: false } },
            { provider: 'grok', key: null },
            { provider: 'openrouter', key: null },
          ],
        },
      },
    );
    expect(await linkedGatewayKeys(env, connectionOf(database), openAccountApi)).toEqual([
      { provider: 'anthropic', alias: 'sg', revision: 'config-sg@' },
      { provider: 'openai', alias: 'main', revision: 'config-main@' },
    ]);

    // Unlinking removes only what CloudChef added, which is nothing here.
    const unlinked = await unlinkGatewayKeyAction({
      request: post(admin.cookie, '/keys/unlink', { provider: 'anthropic' }),
      env,
      openAccountApi,
    });
    expect(unlinked.status).toBe(200);
    expect(cloudflare.providers.map(({ id }) => id)).toEqual(['config-sg', 'config-old', 'config-main']);

    // Linking a key in CloudChef is the admin's choice to replace the provider's keys there.
    await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    expect(cloudflare.providers.map(({ provider_slug, alias }) => `${provider_slug}:${alias}`)).toEqual([
      'openai:old',
      'openai:main',
      'anthropic:cloudchef',
    ]);
  });

  it('uses the newer of two default keys, as when a replaced key could not be removed, whatever their order', async () => {
    const { env, cloudflare, database } = await setup();
    const key = (alias: string, modifiedAt: string) => ({
      id: `config-${alias}`,
      provider_slug: 'anthropic',
      alias,
      default_config: true,
      secret_id: `secret-${alias}`,
      secret_preview: 'sk...wxyz',
      gateway_id: 'default',
      modified_at: modifiedAt,
    });
    const replaced = key('cloudchef-2', '2026-01-01T00:00:00.000Z');
    const replacement = key('cloudchef', '2026-02-01T00:00:00.000Z');

    for (const order of [
      [replaced, replacement],
      [replacement, replaced],
    ]) {
      cloudflare.providers.splice(0, cloudflare.providers.length, ...order);
      expect(await linkedGatewayKeys(env, connectionOf(database), cloudflare.openAccountApi)).toEqual([
        { provider: 'anthropic', alias: 'cloudchef', revision: 'config-cloudchef@2026-02-01T00:00:00.000Z' },
      ]);
    }
  });

  it('uses the newest key of a provider with no default one, whatever their order', async () => {
    const { env, cloudflare, database } = await setup();
    const key = (alias: string, modifiedAt: string) => ({
      id: `config-${alias}`,
      provider_slug: 'openai',
      alias,
      default_config: false,
      secret_id: `secret-${alias}`,
      secret_preview: 'sk...wxyz',
      gateway_id: 'default',
      modified_at: modifiedAt,
    });
    const older = key('first', '2026-01-01T00:00:00.000Z');
    const newer = key('second', '2026-02-01T00:00:00.000Z');

    for (const order of [
      [older, newer],
      [newer, older],
    ]) {
      cloudflare.providers.splice(0, cloudflare.providers.length, ...order);
      expect(await linkedGatewayKeys(env, connectionOf(database), cloudflare.openAccountApi)).toEqual([
        { provider: 'openai', alias: 'second', revision: 'config-second@2026-02-01T00:00:00.000Z' },
      ]);
    }
  });

  it('replaces the key the runtimes use last, when two defaults are left from an interrupted replacement', async () => {
    const { env, admin, cloudflare } = await setup();
    const key = (alias: string, modifiedAt: string) => ({
      id: `config-${alias}`,
      provider_slug: 'anthropic',
      alias,
      default_config: true,
      secret_id: `secret-${alias}`,
      secret_preview: 'sk...wxyz',
      gateway_id: 'default',
      modified_at: modifiedAt,
    });
    // Listed first, but older: the runtimes use the newer one, so that one goes last.
    cloudflare.providers.push(
      key('cloudchef-2', '2026-01-01T00:00:00.000Z'),
      key('cloudchef', '2026-02-01T00:00:00.000Z'),
    );

    const linked = await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
      env,
      openAccountApi: cloudflare.openAccountApi,
    });

    expect(linked.status).toBe(200);
    expect(
      writesOf(cloudflare)
        .filter(({ path }) => path.startsWith(PROVIDER_PATH))
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      `DELETE ${PROVIDER_PATH}/config-cloudchef-2`,
      `POST ${PROVIDER_PATH}`,
      `DELETE ${PROVIDER_PATH}/config-cloudchef`,
    ]);
  });

  it('links and unlinks each provider on its own', async () => {
    const { env, admin, cloudflare, database } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    for (const provider of GATEWAY_PROVIDER_SLUGS) {
      const linked = await linkGatewayKeyAction({
        request: post(admin.cookie, '/keys/link', { provider, apiKey: PASTED_KEY }),
        env,
        openAccountApi,
      });
      expect(linked.status).toBe(200);
    }
    expect(cloudflare.secrets.map(({ name }) => name)).toEqual([
      'anthropic-startup',
      'default_anthropic_cloudchef',
      'default_openai_cloudchef',
      'default_grok_cloudchef',
      'default_openrouter_cloudchef',
    ]);
    expect(await linkedGatewayKeys(env, connectionOf(database), openAccountApi)).toEqual(
      GATEWAY_PROVIDER_SLUGS.map((provider) => ({ provider, alias: 'cloudchef', revision: expect.any(String) })),
    );

    await unlinkGatewayKeyAction({
      request: post(admin.cookie, '/keys/unlink', { provider: 'grok' }),
      env,
      openAccountApi,
    });

    expect(cloudflare.providers.map(({ provider_slug }) => provider_slug)).toEqual([
      'anthropic',
      'openai',
      'openrouter',
    ]);
    expect(cloudflare.secrets.map(({ name }) => name)).not.toContain('default_grok_cloudchef');
  });

  it('never reports a key for a connection whose authorization cannot ask', async () => {
    const { env, admin, cloudflare, database } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    const requestsBefore = cloudflare.requests.length;

    const withoutGrant = { ...connectionOf(database), grantedCapabilities: ALL_CAPABILITIES.slice(0, -1) };
    expect(await linkedGatewayKeys(env, withoutGrant, openAccountApi)).toEqual([]);
    expect(cloudflare.requests).toHaveLength(requestsBefore);
    // Cloudflare unreachable: also a no.
    const unreachable = async () => Promise.reject(new Error('unreachable'));
    expect(await linkedGatewayKeys(env, connectionOf(database), unreachable)).toEqual([]);
  });

  it('shows a member the setting but lets only an admin change it', async () => {
    const { env, member, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;

    expect(await (await modelSettingsAction({ request: get(member.cookie), env, openAccountApi })).json()).toEqual({
      canManage: false,
      defaultModelId: null,
      keys: NO_KEYS,
    });
    const attempts = [
      linkGatewayKeyAction({
        request: post(member.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
        env,
        openAccountApi,
      }),
      unlinkGatewayKeyAction({
        request: post(member.cookie, '/keys/unlink', { provider: 'anthropic' }),
        env,
        openAccountApi,
      }),
      updateDefaultModelAction({
        request: post(member.cookie, '/default', { modelId: 'anthropic/claude-opus-5-5' }),
        env,
      }),
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
      { keys: { status: 'reauthorization_required' } },
    );
    const link = await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
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
    const evil = post(
      admin.cookie,
      '/keys/link',
      { provider: 'anthropic', apiKey: PASTED_KEY },
      'https://evil.example',
    );
    expect((await linkGatewayKeyAction({ request: evil, env, openAccountApi })).status).toBe(403);
    // An existing Secrets Store secret cannot be linked: Cloudflare's provider keys do not find one.
    const invalid: Record<string, string>[] = [
      {},
      { provider: 'anthropic', apiKey: 'short' },
      // A provider CloudChef offers no models for, or none named.
      { provider: 'fireworks', apiKey: PASTED_KEY },
      { apiKey: PASTED_KEY },
      { provider: 'anthropic', secretId: 'secret-startup' },
      { provider: 'anthropic', apiKey: PASTED_KEY, secretId: 'secret-startup' },
    ];
    for (const body of invalid) {
      const response = await linkGatewayKeyAction({
        request: post(admin.cookie, '/keys/link', body),
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
      request: post(admin.cookie, '/default', { modelId: 'anthropic/claude-opus-5-5' }),
      env,
    });
    expect(await chosen.json()).toEqual({ defaultModelId: 'anthropic/claude-opus-5-5' });
    expect(database.prepare('SELECT default_builder_model AS model FROM cloudflare_connections').get()).toEqual({
      model: 'anthropic/claude-opus-5-5',
    });

    for (const modelId of ['gpt-4', '@cf/../x', '']) {
      expect(
        (await updateDefaultModelAction({ request: post(admin.cookie, '/default', { modelId }), env })).status,
      ).toBe(400);
    }
    const cleared = await updateDefaultModelAction({ request: post(admin.cookie, '/default', { modelId: null }), env });
    expect(await cleared.json()).toEqual({ defaultModelId: null });
  });

  it("reaches the member's runtime with the account's provider keys and their aliases, for its catalog", async () => {
    const { env, admin, member, database } = await setup();
    await updateDefaultModelAction({
      request: post(admin.cookie, '/default', { modelId: 'anthropic/claude-opus-5-5' }),
      env,
    });
    const secret = await deriveUserWorkspaceRuntimeSecret({
      encryptionKeyBase64: ENCRYPTION_KEY,
      userId: member.userId,
      accountId: ACCOUNT_ID,
      connectionGeneration: 1,
      organizationConnectionId: 'acme-connection',
    });
    const ask = (keys: GatewayKey[], bearer = secret) =>
      runtimeModelsAction({
        request: new Request(`${ORIGIN}/api/cloudflare/runtime-models`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
            ...runtimeIdentityHeaders({
              userId: member.userId,
              connectionId: 'acme-connection',
              connectionGeneration: 1,
            }),
          },
          body: '{}',
        }),
        env,
        gatewayKeys: async () => keys,
      });

    const keys: GatewayKey[] = [{ provider: 'anthropic', alias: 'sg' }];
    expect(await (await ask(keys)).json()).toEqual({
      defaultModelId: 'anthropic/claude-opus-5-5',
      gatewayKeys: keys,
    });
    expect((await ask(keys, 'b'.repeat(43))).status).toBe(401);

    // A paused member's runtime learns nothing.
    database.prepare('UPDATE organization_members SET paused_at = 1 WHERE user_id = ?').run(member.userId);
    expect((await ask(keys)).status).toBe(401);
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
    connectedAt: 1,
    updatedAt: 1,
    generation: 1,
  };
}
