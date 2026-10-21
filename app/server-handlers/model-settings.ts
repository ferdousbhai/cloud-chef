import { z } from 'zod';
import { getAuthSession, type CloudflareAuthSession } from '~/lib/.server/auth';
import { hasSameOrigin, readJsonRequest } from '~/lib/.server/request-guards';
import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import {
  AI_GATEWAY_ID,
  canManageAiGatewayKeys,
  CLOUDCHEF_KEY_ALIAS,
  cloudchefKeySecretName,
  findGatewayKeys,
  openGatewayKeyAccountApi,
  type GatewayKeyAccountApi,
  type OpenGatewayKeyAccountApi,
} from '~/lib/.server/cloudflare/ai-gateway-keys';
import { CloudflareAccountApiError } from '~/lib/.server/cloudflare/user-account-api';
import {
  canManageModels,
  readDefaultBuilderModel,
  setDefaultBuilderModel,
} from '~/lib/cloudflare/data/builder-model-settings.server';
import { builderModelIdSchema, GATEWAY_PROVIDER_SLUGS, type GatewayProviderSlug } from '~/lib/workers-ai-model';
import { sessionConnection } from './cloudflare-integration';

/**
 * Settings, under Models: the model an account's builders start on, and the account's own keys for
 * the AI Gateway providers whose models it offers (Anthropic, OpenAI, …), stored in the account's
 * own Secrets Store and attached to its default AI Gateway. A team's admins (or the person whose own
 * account it is) choose both; everyone else sees them and can still switch models in the picker.
 * Which keys are there is read from the account each time, whoever added them; a pasted key goes
 * from the browser to Cloudflare once and is never kept, logged, or returned by CloudChef.
 */

/** One provider's key on the account's default gateway, as Settings shows it: never the key itself. */
type ProviderKeyStatus = {
  provider: GatewayProviderSlug;
  key: {
    alias: string;
    /** Cloudflare's masked preview of the key. */
    secretPreview: string | null;
    /** Linked from Settings under CloudChef's alias, rather than added in Cloudflare. */
    addedByCloudChef: boolean;
  } | null;
};

type GatewayKeysStatus =
  | { status: 'ready'; providers: ProviderKeyStatus[] }
  /** The connection was authorized before CloudChef could manage AI Gateway keys. */
  | { status: 'reauthorization_required' }
  /** Cloudflare could not be asked just now. */
  | { status: 'unknown' };

type Context = {
  session: CloudflareAuthSession;
  connection: CloudflareConnection;
  canManage: boolean;
};

type Deps = { openAccountApi?: OpenGatewayKeyAccountApi };

async function withContext(
  request: Request,
  env: Env,
  handler: (context: Context) => Promise<Response>,
  { manage = false }: { manage?: boolean } = {},
): Promise<Response> {
  if (request.method !== 'GET' && !hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Sign in first.' }, { status: 401 });
  }
  const connection = await sessionConnection(env.DB, session);
  if (!connection) {
    return Response.json({ error: 'Connect a Cloudflare account first.' }, { status: 409 });
  }
  const canManage = await canManageModels(env.DB, session.user.id, connection);
  if (manage && !canManage) {
    return Response.json({ error: "Only the team's admins can change its models." }, { status: 403 });
  }
  return handler({ session, connection, canManage });
}

/** The account's models as Settings shows them. */
export function modelSettingsAction({ request, env, openAccountApi = openGatewayKeyAccountApi }: RequestArgs & Deps) {
  return withContext(request, env, async ({ connection, canManage }) => {
    const defaultModelId = await readDefaultBuilderModel(env.DB, connection.id);
    if (!canManageAiGatewayKeys(connection)) {
      return settingsResponse({ canManage, defaultModelId, keys: { status: 'reauthorization_required' } });
    }
    let api: GatewayKeyAccountApi;
    try {
      api = await openAccountApi(env, connection);
    } catch {
      return settingsResponse({ canManage, defaultModelId, keys: { status: 'unknown' } });
    }
    return settingsResponse({ canManage, defaultModelId, keys: await gatewayKeysStatus(api) });
  });
}

const providerSchema = z.enum(GATEWAY_PROVIDER_SLUGS);

// Provider keys are opaque tokens; this only refuses what cannot be one.
const linkSchema = z.strictObject({
  provider: providerSchema,
  apiKey: z.string().trim().min(20).max(512).regex(/^\S+$/),
});

const unlinkSchema = z.strictObject({ provider: providerSchema });

/**
 * Links a pasted key for one provider to the account's default gateway, which Cloudflare stores in
 * the account's Secrets Store (Cloudflare's own BYOK flow), replacing every key the gateway held for
 * that provider, including one added in Cloudflare: Settings says so before an admin links. The
 * gateway is readied first: Cloudflare takes a key only on a gateway with authentication on and a
 * Secrets Store linked, so one without either gets them, with every other setting kept. Turning
 * authentication on is reported, since the account's own apps calling the gateway over HTTP then
 * need a gateway token; CloudChef's runtime reaches it through its Worker binding and needs none.
 */
export function linkGatewayKeyAction({ request, env, openAccountApi = openGatewayKeyAccountApi }: RequestArgs & Deps) {
  return withContext(
    request,
    env,
    async ({ connection }) => {
      if (!canManageAiGatewayKeys(connection)) {
        return reauthorizationRequired();
      }
      const body = await readJsonRequest(request, linkSchema, 'Choose a provider and paste its API key.');
      if ('response' in body) {
        return body.response;
      }
      const { provider, apiKey } = body.data;
      return withAccountApi(env, connection, openAccountApi, async (api) => {
        // The gateway keeps the store it has; only a gateway without one is linked to this.
        const [firstStore] = await api.listSecretsStores();
        if (!firstStore) {
          return Response.json(
            {
              error:
                'This Cloudflare account has no Secrets Store to keep the key in. Create one in the Cloudflare dashboard (Secrets Store), then try again.',
            },
            { status: 400 },
          );
        }
        const { authenticationTurnedOn } = await api.prepareAiGatewayForKeys(AI_GATEWAY_ID, firstStore.id);
        await removeProviderKeys(api, provider, { onlyCloudChefs: false });
        await api.addAiGatewayProviderKey(AI_GATEWAY_ID, {
          providerSlug: provider,
          alias: CLOUDCHEF_KEY_ALIAS,
          secret: apiKey,
        });
        return keysResponse(await gatewayKeysStatus(api), { authenticationTurnedOn });
      });
    },
    { manage: true },
  );
}

/**
 * Removes the key CloudChef linked for one provider from the account's default gateway, and the
 * secret Cloudflare kept it in. A key added in Cloudflare is left as it is: an admin removes that one
 * there. The gateway's settings stay as linking left them.
 */
export function unlinkGatewayKeyAction({
  request,
  env,
  openAccountApi = openGatewayKeyAccountApi,
}: RequestArgs & Deps) {
  return withContext(
    request,
    env,
    async ({ connection }) => {
      if (!canManageAiGatewayKeys(connection)) {
        return reauthorizationRequired();
      }
      const body = await readJsonRequest(request, unlinkSchema, 'Choose a provider.');
      if ('response' in body) {
        return body.response;
      }
      return withAccountApi(env, connection, openAccountApi, async (api) => {
        await removeProviderKeys(api, body.data.provider, { onlyCloudChefs: true });
        return keysResponse(await gatewayKeysStatus(api));
      });
    },
    { manage: true },
  );
}

const defaultModelSchema = z.strictObject({ modelId: builderModelIdSchema.nullable() });

/**
 * Chooses the model the account's builders start on (null for CloudChef's default). Not checked against
 * a catalog here: a workspace offers it while the account can run it, and starts elsewhere otherwise.
 */
export function updateDefaultModelAction({ request, env }: RequestArgs) {
  return withContext(
    request,
    env,
    async ({ connection }) => {
      const body = await readJsonRequest(request, defaultModelSchema, 'Choose a model.');
      if ('response' in body) {
        return body.response;
      }
      await setDefaultBuilderModel(env.DB, connection.id, body.data.modelId);
      return Response.json(
        { defaultModelId: await readDefaultBuilderModel(env.DB, connection.id) },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    },
    { manage: true },
  );
}

type RequestArgs = { request: Request; env: Env };

async function withAccountApi(
  env: Env,
  connection: CloudflareConnection,
  open: OpenGatewayKeyAccountApi,
  operation: (api: GatewayKeyAccountApi) => Promise<Response>,
): Promise<Response> {
  try {
    return await operation(await open(env, connection));
  } catch (error) {
    // Cloudflare's own refusal is the actionable message (a missing gateway, a store limit); it never
    // carries the key, which goes only in the request body.
    const message =
      error instanceof CloudflareAccountApiError ? error.message : 'Cloudflare could not be reached. Try again.';
    console.warn('Unable to change a provider key on the account’s AI Gateway');
    return Response.json({ error: message }, { status: 502 });
  }
}

/**
 * Removes one provider's keys from the gateway (only CloudChef's own, or every one), then the secret
 * Cloudflare kept CloudChef's in: the name is CloudChef's, and a new key under the same alias cannot
 * be stored while it is there. No other secret is touched, whoever made it.
 */
async function removeProviderKeys(
  api: GatewayKeyAccountApi,
  provider: GatewayProviderSlug,
  { onlyCloudChefs }: { onlyCloudChefs: boolean },
): Promise<void> {
  for (const key of await api.listAiGatewayProviderKeys(AI_GATEWAY_ID)) {
    if (key.providerSlug === provider && (!onlyCloudChefs || key.alias === CLOUDCHEF_KEY_ALIAS)) {
      await api.deleteAiGatewayProviderKey(AI_GATEWAY_ID, key.id);
    }
  }
  const secretName = cloudchefKeySecretName(provider);
  for (const secret of await api.listAiGatewaySecrets()) {
    if (secret.name === secretName) {
      await api.deleteSecret(secret.storeId, secret.id);
    }
  }
}

async function gatewayKeysStatus(api: GatewayKeyAccountApi): Promise<GatewayKeysStatus> {
  try {
    const keys = await findGatewayKeys(api);
    return {
      status: 'ready',
      providers: GATEWAY_PROVIDER_SLUGS.map((provider) => {
        const key = keys.get(provider);
        return {
          provider,
          key: key
            ? {
                alias: key.alias || 'default',
                secretPreview: key.secretPreview,
                addedByCloudChef: key.alias === CLOUDCHEF_KEY_ALIAS,
              }
            : null,
        };
      }),
    };
  } catch {
    return { status: 'unknown' };
  }
}

function settingsResponse(body: {
  canManage: boolean;
  defaultModelId: string | null;
  keys: GatewayKeysStatus;
}): Response {
  return Response.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
}

function keysResponse(keys: GatewayKeysStatus, extra: { authenticationTurnedOn?: boolean } = {}): Response {
  return Response.json({ keys, ...extra }, { headers: { 'Cache-Control': 'private, no-store' } });
}

function reauthorizationRequired(): Response {
  return Response.json(
    {
      code: 'cloudflare_reauthorization_required',
      error: 'Reauthorize Cloudflare so CloudChef can link a key to this account’s AI Gateway.',
    },
    { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
