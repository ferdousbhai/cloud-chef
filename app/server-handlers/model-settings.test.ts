import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { createAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import { createOrganization } from '~/lib/cloudflare/data/organizations.server';
import { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import { linkedGatewayKeys } from '~/lib/.server/cloudflare/ai-gateway-keys';
import { CORE_CLOUDFLARE_OAUTH_SCOPES } from '~/lib/.server/cloudflare/cloudflare-oauth-scope-manifest';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  GATEWAY_PROVIDER_SLUGS,
  type GatewayKey,
  type GatewayProviderSlug,
} from '~/lib/workers-ai-model';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { runtimeIdentityHeaders } from '~/lib/.server/cloudflare/runtime-identity-headers';
import {
  linkGatewayKeyAction,
  modelSettingsAction,
  unlinkGatewayKeyAction,
  updateAllowedModelsAction,
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
const ALL_SCOPES: string[] = [...CORE_CLOUDFLARE_OAUTH_SCOPES];
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
  const openAccountApi = async () => {
    vi.stubGlobal('fetch', request);
    return new UserCloudflareAccountApi(ACCOUNT_ID, 'oauth-token');
  };
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
  scopes = ALL_SCOPES,
  cloudflare = fakeCloudflare(),
}: { scopes?: string[]; cloudflare?: ReturnType<typeof fakeCloudflare> } = {}) {
  const { database, db } = controlPlaneDatabase();
  const env = envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY });
  const signIn = async (email: string) => {
    const user = await upsertVerifiedEmailUser(db, { email });
    const cookie =
      (await createAuthSession(env, user.id, new Request('https://cloudchef.build/'))).cookie.split(';')[0] ?? '';
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
      `INSERT INTO cloudflare_connections (id, org_id, account_id, account_name, status, created_at, updated_at)
       VALUES ('acme-connection', ?, ?, 'Acme', 'active', 1, 1)`,
    )
    .run(orgId, ACCOUNT_ID);
  database
    .prepare(
      `INSERT INTO cloudflare_authorizations (account_id, credential_handle, granted_oauth_scopes_json, created_at,
         updated_at)
       VALUES (?, 'credential-1', ?, 1, 1)`,
    )
    .run(ACCOUNT_ID, JSON.stringify(scopes));
  return { database, env, admin, member, cloudflare };
}

function get(cookie: string): Request {
  return new Request(`${ORIGIN}/api/settings/models`, { headers: { cookie } });
}

/** A field of a Settings request body, as a test sends it, well-formed or not. */
type BodyField = string | number | null | undefined | readonly (string | number)[];

function post(cookie: string, path: string, body: Record<string, BodyField>, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/settings/models${path}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

/** Settings' answer for an account whose gateway holds no key CloudChef offers a provider's models for. */
const NO_KEYS = {
  status: 'ready',
  providers: GATEWAY_PROVIDER_SLUGS.map((provider) => ({ provider, key: null, otherAliases: [] })),
};

/** Settings' answer with one provider's key on the gateway. */
function keysWith(
  provider: GatewayProviderSlug,
  key: { secretPreview: string | null } | null,
  otherAliases: string[] = [],
) {
  return {
    status: 'ready',
    providers: GATEWAY_PROVIDER_SLUGS.map((candidate) => ({
      provider: candidate,
      key: candidate === provider ? key : null,
      otherAliases: candidate === provider ? otherAliases : [],
    })),
  };
}

function writesOf(cloudflare: ReturnType<typeof fakeCloudflare>) {
  return cloudflare.requests.filter(({ method }) => method !== 'GET');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings: models', () => {
  it("links a pasted key without keeping it, giving a gateway without a store the account's store", async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;

    const before = await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi });
    expect(before.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await before.json()).toEqual({
      canManage: true,
      defaultModelId: null,
      allowedModelIds: null,
      keys: NO_KEYS,
    });

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
      keys: keysWith('anthropic', { secretPreview: 'sk-a...6789' }),
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
      alias: 'default',
      default_config: true,
      secret: PASTED_KEY,
    });
    expect(cloudflare.secrets.map(({ name }) => name)).toEqual(['anthropic-startup', 'default_anthropic_default']);
    expect(await (await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi })).json()).toMatchObject(
      { keys: keysWith('anthropic', { secretPreview: 'sk-a...6789' }) },
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
      keys: keysWith('anthropic', { secretPreview: 'sk-a...6789' }),
      authenticationTurnedOn: false,
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
      keys: keysWith('anthropic', { secretPreview: 'sk-a...6789' }),
      authenticationTurnedOn: true,
    });
    expect(cloudflare.gateway()).toMatchObject({ authentication: true, store_id: 'store-2', rate_limiting_limit: 50 });
    expect(cloudflare.secrets).toContainEqual(
      expect.objectContaining({ name: 'default_anthropic_default', storeId: 'store-2' }),
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
      keys: keysWith('anthropic', { secretPreview: 'sk-a...6789' }),
      authenticationTurnedOn: true,
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

  it("relinks by replacing the provider's default key and its secret, never the admin's own secret", async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    const link = (apiKey: string) =>
      linkGatewayKeyAction({
        request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey }),
        env,
        openAccountApi,
      });
    await link(PASTED_KEY);
    const firstKey = cloudflare.providers[0];
    const firstSecret = cloudflare.secrets.find(({ name }) => name === 'default_anthropic_default');

    const relinked = await link('sk-ant-api03-a-second-test-key-9876543210');

    expect(await relinked.json()).toMatchObject({ keys: keysWith('anthropic', { secretPreview: 'sk-a...3210' }) });
    expect(cloudflare.providers).toEqual([expect.objectContaining({ provider_slug: 'anthropic', alias: 'default' })]);
    // Cloudflare refuses a key under a name already taken, so the old one goes first.
    expect(
      writesOf(cloudflare)
        .slice(-3)
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      `DELETE ${PROVIDER_PATH}/${firstKey?.id}`,
      `DELETE /secrets_store/stores/store-1/secrets/${firstSecret?.id}`,
      `POST ${PROVIDER_PATH}`,
    ]);
    expect(cloudflare.secrets).toEqual([
      ADMIN_SECRET,
      expect.objectContaining({ name: 'default_anthropic_default', storeId: 'store-1' }),
    ]);
  });

  it('says so when Cloudflare refuses a key, and changes nothing when the one it replaces cannot be removed', async () => {
    const { env, admin, cloudflare } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    const link = (apiKey: string) =>
      linkGatewayKeyAction({
        request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey }),
        env,
        openAccountApi,
      });

    const refused = await link(REFUSED_KEY);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: 'The provider key is not valid' });
    expect(cloudflare.providers).toEqual([]);

    await link(PASTED_KEY);
    const before = cloudflare.providers.map((config) => ({ ...config }));
    cloudflare.refuseDeletes();
    const stuck = await link('sk-ant-api03-a-second-test-key-9876543210');
    expect(stuck.status).toBe(502);
    expect(cloudflare.providers).toEqual(before);
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
      { provider: 'anthropic', revision: expect.stringMatching(/^config-/) },
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

  it('uses a key added in Cloudflare only under the name default, and says which keys it cannot use', async () => {
    const { env, admin, cloudflare, database } = await setup();
    const openAccountApi = cloudflare.openAccountApi;
    const dashboardKey = (id: string, provider: string, alias: string) => ({
      id,
      provider_slug: provider,
      alias,
      default_config: false,
      secret_id: `secret-${id}`,
      secret_preview: `${alias.slice(0, 2)}...wxyz`,
      gateway_id: 'default',
    });
    cloudflare.providers.push(
      dashboardKey('config-sg', 'anthropic', 'sg'),
      dashboardKey('config-old', 'openai', 'old'),
      dashboardKey('config-main', 'openai', 'default'),
    );

    // Cloudflare uses only a provider's key named default on CloudChef's requests.
    expect(await (await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi })).json()).toMatchObject(
      {
        keys: {
          status: 'ready',
          providers: [
            { provider: 'anthropic', key: null, otherAliases: ['sg'] },
            { provider: 'openai', key: { secretPreview: 'de...wxyz' }, otherAliases: ['old'] },
            { provider: 'grok', key: null, otherAliases: [] },
            { provider: 'openrouter', key: null, otherAliases: [] },
          ],
        },
      },
    );
    expect(await linkedGatewayKeys(env, connectionOf(database), openAccountApi)).toEqual([
      { provider: 'openai', revision: 'config-main@' },
    ]);

    // Linking a key in CloudChef saves it under that name, and leaves the others as they are.
    await linkGatewayKeyAction({
      request: post(admin.cookie, '/keys/link', { provider: 'anthropic', apiKey: PASTED_KEY }),
      env,
      openAccountApi,
    });
    // Unlinking removes the key CloudChef uses, whoever added it, and only that one.
    const unlinked = await unlinkGatewayKeyAction({
      request: post(admin.cookie, '/keys/unlink', { provider: 'openai' }),
      env,
      openAccountApi,
    });
    expect(unlinked.status).toBe(200);
    expect(cloudflare.providers.map(({ provider_slug, alias }) => `${provider_slug}:${alias}`)).toEqual([
      'anthropic:sg',
      'openai:old',
      'anthropic:default',
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
      'default_anthropic_default',
      'default_openai_default',
      'default_grok_default',
      'default_openrouter_default',
    ]);
    expect(await linkedGatewayKeys(env, connectionOf(database), openAccountApi)).toEqual(
      GATEWAY_PROVIDER_SLUGS.map((provider) => ({ provider, revision: expect.any(String) })),
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
    expect(cloudflare.secrets.map(({ name }) => name)).not.toContain('default_grok_default');
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

    const withoutGrant = { ...connectionOf(database), grantedOAuthScopes: ALL_SCOPES.slice(0, -1) };
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
      allowedModelIds: null,
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
      updateAllowedModelsAction({
        request: post(member.cookie, '/allowed', { modelIds: [CLOUDFLARE_WORKERS_AI_MODEL] }),
        env,
      }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(403);
    }
    expect(writesOf(cloudflare)).toEqual([]);
  });

  it('asks for a reauthorization when the connection predates AI Gateway keys, without calling Cloudflare', async () => {
    const { env, admin, cloudflare } = await setup({ scopes: ALL_SCOPES.slice(0, -1) });
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
    expect(await chosen.json()).toEqual({ defaultModelId: 'anthropic/claude-opus-5-5', allowedModelIds: null });
    expect(database.prepare('SELECT default_builder_model AS model FROM cloudflare_connections').get()).toEqual({
      model: 'anthropic/claude-opus-5-5',
    });

    for (const modelId of ['gpt-4', '@cf/../x', '']) {
      expect(
        (await updateDefaultModelAction({ request: post(admin.cookie, '/default', { modelId }), env })).status,
      ).toBe(400);
    }
    const cleared = await updateDefaultModelAction({ request: post(admin.cookie, '/default', { modelId: null }), env });
    expect(await cleared.json()).toEqual({ defaultModelId: null, allowedModelIds: null });
  });

  it("reaches the member's runtime with the account's provider keys, for its catalog", async () => {
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

    const keys: GatewayKey[] = [{ provider: 'anthropic', revision: 'key@1' }];
    expect(await (await ask(keys)).json()).toEqual({
      defaultModelId: 'anthropic/claude-opus-5-5',
      gatewayKeys: keys,
      allowedModelIds: null,
    });
    await updateAllowedModelsAction({
      request: post(admin.cookie, '/allowed', { modelIds: ['anthropic/claude-opus-5-5', CLOUDFLARE_WORKERS_AI_MODEL] }),
      env,
    });
    expect(await (await ask(keys)).json()).toMatchObject({
      allowedModelIds: ['anthropic/claude-opus-5-5', CLOUDFLARE_WORKERS_AI_MODEL],
    });
    expect((await ask(keys, 'b'.repeat(43))).status).toBe(401);

    // A paused member's runtime learns nothing.
    database.prepare('UPDATE organization_members SET paused_at = 1 WHERE user_id = ?').run(member.userId);
    expect((await ask(keys)).status).toBe(401);
  });
});

describe('the models the picker offers', () => {
  const OPUS = 'anthropic/claude-opus-5-5';
  const allowed = (cookie: string, modelIds: BodyField, env: Env) =>
    updateAllowedModelsAction({ request: post(cookie, '/allowed', { modelIds }), env });
  const stored = (database: Awaited<ReturnType<typeof setup>>['database']) =>
    database
      .prepare(
        'SELECT default_builder_model AS model, allowed_builder_models_json AS allowed FROM cloudflare_connections',
      )
      .get();

  it('are every compatible model until an admin chooses, then only those chosen, and every one again with null', async () => {
    const { env, admin, database, cloudflare } = await setup();

    const chosen = await allowed(admin.cookie, [CLOUDFLARE_WORKERS_AI_MODEL, OPUS, OPUS], env);
    expect(chosen.status).toBe(200);
    // The default CloudChef pins is kept by its id once a list is chosen, so a later pin can't fall off the list.
    expect(await chosen.json()).toEqual({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      allowedModelIds: [CLOUDFLARE_WORKERS_AI_MODEL, OPUS],
    });
    expect(
      await (
        await modelSettingsAction({ request: get(admin.cookie), env, openAccountApi: cloudflare.openAccountApi })
      ).json(),
    ).toMatchObject({ allowedModelIds: [CLOUDFLARE_WORKERS_AI_MODEL, OPUS] });

    const everything = await allowed(admin.cookie, null, env);
    // Back to every model, the pin's default follows CloudChef's pin again.
    expect(await everything.json()).toEqual({ defaultModelId: null, allowedModelIds: null });
    expect(stored(database)).toEqual({ model: null, allowed: null });
  });

  it('always include the default model: a list without it, or a default not on the list, is refused', async () => {
    const { env, admin, database } = await setup();

    // CloudChef's pinned model is the default while none is chosen.
    const withoutPin = await allowed(admin.cookie, [OPUS], env);
    expect(withoutPin.status).toBe(409);
    expect(await withoutPin.json()).toEqual({
      error: expect.stringContaining('GLM 5.3 Flash, has to stay allowed. To leave it out, choose another default'),
    });
    // Nothing at all would leave the default out too.
    expect((await allowed(admin.cookie, [], env)).status).toBe(409);
    expect(stored(database)).toEqual({ model: null, allowed: null });

    // Choosing the default first lets the pin be left out.
    await updateDefaultModelAction({ request: post(admin.cookie, '/default', { modelId: OPUS }), env });
    expect((await allowed(admin.cookie, [OPUS], env)).status).toBe(200);
    expect(stored(database)).toEqual({ model: OPUS, allowed: JSON.stringify([OPUS]) });

    // Now neither the pin (null) nor another model left out can become the default.
    for (const modelId of [null, 'openai/gpt-5']) {
      const refused = await updateDefaultModelAction({ request: post(admin.cookie, '/default', { modelId }), env });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: expect.stringContaining('Allow it under') });
    }
    expect(stored(database)).toEqual({ model: OPUS, allowed: JSON.stringify([OPUS]) });
  });

  it('refuses what is not a list of model ids, changing nothing', async () => {
    const { env, admin, database } = await setup();

    for (const modelIds of [undefined, 'all', ['gpt-4'], [7], [CLOUDFLARE_WORKERS_AI_MODEL, '@cf/../x']]) {
      expect((await allowed(admin.cookie, modelIds, env)).status).toBe(400);
    }
    const extra = await updateAllowedModelsAction({
      request: post(admin.cookie, '/allowed', { modelIds: null, defaultModelId: OPUS }),
      env,
    });
    expect(extra.status).toBe(400);
    expect(stored(database)).toEqual({ model: null, allowed: null });
  });

  it("takes a list as long as the catalog, which a small form's limit would refuse", async () => {
    const { env, admin } = await setup();
    const many = [
      CLOUDFLARE_WORKERS_AI_MODEL,
      ...Array.from({ length: 999 }, (_, index) => `openrouter/vendor-${index}/a-model-with-a-long-name-${index}`),
    ];
    const saved = await allowed(admin.cookie, many, env);
    expect(saved.status).toBe(200);
    expect(z.object({ allowedModelIds: z.array(z.string()) }).parse(await saved.json()).allowedModelIds).toHaveLength(
      1_000,
    );
    expect((await allowed(admin.cookie, [...many, 'openai/one-too-many'], env)).status).toBe(400);
  });
});

function connectionOf(database: ReturnType<typeof controlPlaneDatabase>['database']) {
  const row = z.object({ id: z.string(), account_id: z.string(), granted_oauth_scopes_json: z.string() }).parse(
    database
      .prepare(
        `SELECT connections.id, connections.account_id, authorizations.granted_oauth_scopes_json
           FROM cloudflare_connections AS connections
           JOIN cloudflare_authorizations AS authorizations ON authorizations.account_id = connections.account_id`,
      )
      .get(),
  );
  return {
    id: row.id,
    userId: null,
    orgId: 'org',
    accountId: row.account_id,
    accountName: 'Acme',
    status: 'active' as const,
    credentialHandle: 'credential-1',
    grantedOAuthScopes: z.array(z.string()).parse(JSON.parse(row.granted_oauth_scopes_json)),
    connectedAt: 1,
    updatedAt: 1,
    generation: 1,
  };
}
