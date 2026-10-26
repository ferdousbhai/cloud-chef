import { knownModelLabel } from '~/lib/.server/llm/workers-ai-model-catalog';
import { z } from 'zod';
import type { CloudflareAuthSession } from '~/lib/.server/auth';
import { readJsonRequest } from '~/lib/.server/request-guards';
import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import {
  AI_GATEWAY_ID,
  defaultKeySecretName,
  findGatewayKeys,
  isDefaultAlias,
  openGatewayKeyAccountApi,
  type GatewayKeyAccountApi,
  type OpenGatewayKeyAccountApi,
} from '~/lib/.server/cloudflare/ai-gateway-keys';
import { missingCoreOAuthScopes } from '~/lib/.server/cloudflare/cloudflare-oauth-scope-manifest';
import { CloudflareAccountApiError } from '~/lib/.server/cloudflare/user-account-api';
import {
  canManageModels,
  readBuilderModelSettings,
  setAllowedBuilderModels,
  setDefaultBuilderModel,
  type BuilderModelSettings,
} from '~/lib/cloudflare/data/builder-model-settings.server';
import {
  allowedBuilderModelIdsSchema,
  builderModelIdSchema,
  effectiveDefaultModelId,
  GATEWAY_KEY_ALIAS,
  GATEWAY_PROVIDER_SLUGS,
  isBuilderModelId,
  modelIdLabel,
  type GatewayProviderSlug,
} from '~/lib/workers-ai-model';
import { sessionConnection } from './cloudflare-integration';
import { signedIn } from './signed-in';

/**
 * Settings, under Models: the model an account's builders start on, which models its picker offers,
 * and the account's own keys for the AI Gateway providers whose models it offers (Anthropic, OpenAI,
 * …), stored in the account's own Secrets Store and attached to its default AI Gateway. A team's
 * admins (or the person whose own account it is) choose all three; everyone else sees them and can
 * still switch among the allowed models in the picker.
 * Which keys are there is read from the account each time, whoever added them; a pasted key goes
 * from the browser to Cloudflare once and is never kept, logged, or returned by CloudChef.
 */

/** One provider's key on the account's default gateway, as Settings shows it: never the key itself. */
type ProviderKeyStatus = {
  provider: GatewayProviderSlug;
  /** The key CloudChef uses, the provider's `default` one. */
  key: {
    /** Cloudflare's masked preview of the key. */
    secretPreview: string | null;
  } | null;
  /** The aliases of the provider's other keys on the gateway, which CloudChef can't use. */
  otherAliases: string[];
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

/**
 * Runs `handler` for a signed-in request in a connected account. `manage` requires the person to be able
 * to change the account's models, and `'keys'` also the connection to be authorized for its gateway keys.
 */
function withContext(
  request: Request,
  env: Env,
  handler: (context: Context) => Promise<Response>,
  { manage = false }: { manage?: boolean | 'keys' } = {},
): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const connection = await sessionConnection(env.DB, session);
    if (!connection) {
      return Response.json({ error: 'Connect a Cloudflare account first.' }, { status: 409 });
    }
    const canManage = await canManageModels(env.DB, session.user.id, connection);
    if (manage && !canManage) {
      return Response.json({ error: "Only the team's admins can change its models." }, { status: 403 });
    }
    if (manage === 'keys' && missingCoreOAuthScopes(connection.grantedOAuthScopes).length > 0) {
      return reauthorizationRequired();
    }
    return handler({ session, connection, canManage });
  });
}

/** The account's models as Settings shows them. */
export function modelSettingsAction({ request, env, openAccountApi = openGatewayKeyAccountApi }: RequestArgs & Deps) {
  return withContext(request, env, async ({ connection, canManage }) => {
    const models = await readBuilderModelSettings(env.DB, connection.id);
    if (missingCoreOAuthScopes(connection.grantedOAuthScopes).length > 0) {
      return settingsResponse({ canManage, ...models, keys: { status: 'reauthorization_required' } });
    }
    let api: GatewayKeyAccountApi;
    try {
      api = await openAccountApi(env, connection);
    } catch {
      return settingsResponse({ canManage, ...models, keys: { status: 'unknown' } });
    }
    return settingsResponse({ canManage, ...models, keys: await gatewayKeysStatus(api) });
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
 * the account's Secrets Store (Cloudflare's own BYOK flow), as the provider's `default` key, the one
 * CloudChef uses: it replaces the key under that alias, including one added in Cloudflare (Settings
 * says so before an admin links), and leaves the provider's keys under other aliases as they are. The
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
        // Cloudflare refuses a key under an alias, or a secret name, already taken: the provider's
        // `default` key goes first, and the new one takes its place. Keys under other aliases stay.
        await removeDefaultKey(api, provider);
        await api.addAiGatewayProviderKey(AI_GATEWAY_ID, {
          providerSlug: provider,
          alias: GATEWAY_KEY_ALIAS,
          secret: apiKey,
        });
        return keysResponse(await gatewayKeysStatus(api), { authenticationTurnedOn });
      });
    },
    { manage: 'keys' },
  );
}

/**
 * Removes the key CloudChef uses for one provider (its `default` one) from the account's default
 * gateway, and the secret Cloudflare kept it in. Keys under other aliases are left as they are. The
 * gateway's settings stay as linking left them.
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
      const body = await readJsonRequest(request, unlinkSchema, 'Choose a provider.');
      if ('response' in body) {
        return body.response;
      }
      return withAccountApi(env, connection, openAccountApi, async (api) => {
        await removeDefaultKey(api, body.data.provider);
        return keysResponse(await gatewayKeysStatus(api));
      });
    },
    { manage: 'keys' },
  );
}

const defaultModelSchema = z.strictObject({ modelId: builderModelIdSchema.nullable() });

/**
 * Chooses the model the account's builders start on (null for CloudChef's default), which must be one
 * the account allows. Not checked against a catalog here: a workspace offers it while the account can
 * run it, and starts elsewhere otherwise.
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
      if (!(await setDefaultBuilderModel(env.DB, connection.id, body.data.modelId))) {
        return modelsRefused(
          'The default model has to be one the picker offers. Allow it under "Models in the picker" first.',
        );
      }
      return settingsResponse(await readBuilderModelSettings(env.DB, connection.id));
    },
    { manage: true },
  );
}

const allowedModelsSchema = z.strictObject({ modelIds: allowedBuilderModelIdsSchema });

/** Room for every model the catalog can hold, each id up to the longest a model id can be. */
const MAX_ALLOWED_MODELS_REQUEST_BYTES = 256 * 1024;

/**
 * Chooses the models the account's picker offers: null for every compatible model, including ones
 * added later, or a list, after which a model not on it (a new one among them) is neither offered nor
 * run. The list must include the account's default model (CloudChef's pinned one when none is chosen),
 * so new chats always start on a model the picker offers; it is refused otherwise, changing nothing.
 */
export function updateAllowedModelsAction({ request, env }: RequestArgs) {
  return withContext(
    request,
    env,
    async ({ connection }) => {
      const body = await readJsonRequest(
        request,
        allowedModelsSchema,
        'Choose the models to allow.',
        MAX_ALLOWED_MODELS_REQUEST_BYTES,
      );
      if ('response' in body) {
        return body.response;
      }
      if (!(await setAllowedBuilderModels(env.DB, connection.id, body.data.modelIds))) {
        // Another admin may have changed the default meanwhile: the answer names the one that stands now.
        const current = await readBuilderModelSettings(env.DB, connection.id);
        return modelsRefused(
          `The default model, ${defaultModelLabel(effectiveDefaultModelId(current.defaultModelId))}, has to stay allowed. To leave it ` +
            'out, choose another default model first.',
        );
      }
      return settingsResponse(await readBuilderModelSettings(env.DB, connection.id));
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
 * Removes the provider's `default` key from the gateway (the one CloudChef uses, whoever added it) and the secret
 * Cloudflare kept it in, which a new key under the same alias needs free. No other key or secret is touched.
 */
async function removeDefaultKey(api: GatewayKeyAccountApi, provider: GatewayProviderSlug): Promise<void> {
  for (const key of await api.listAiGatewayProviderKeys(AI_GATEWAY_ID)) {
    if (key.providerSlug === provider && isDefaultAlias(key.alias)) {
      await api.deleteAiGatewayProviderKey(AI_GATEWAY_ID, key.id);
    }
  }
  await deleteSecrets(api, [defaultKeySecretName(provider)]);
}

async function deleteSecrets(api: GatewayKeyAccountApi, names: readonly string[]): Promise<void> {
  if (names.length === 0) {
    return;
  }
  for (const secret of await api.listAiGatewaySecrets()) {
    if (names.includes(secret.name)) {
      await api.deleteSecret(secret.storeId, secret.id);
    }
  }
}

async function gatewayKeysStatus(api: GatewayKeyAccountApi): Promise<GatewayKeysStatus> {
  try {
    const listed = await api.listAiGatewayProviderKeys(AI_GATEWAY_ID);
    const keys = await findGatewayKeys({ listAiGatewayProviderKeys: async () => listed });
    return {
      status: 'ready',
      providers: GATEWAY_PROVIDER_SLUGS.map((provider) => {
        const key = keys.get(provider);
        return {
          provider,
          key: key ? { secretPreview: key.secretPreview } : null,
          otherAliases: listed
            .filter(({ providerSlug, alias }) => providerSlug === provider && !isDefaultAlias(alias))
            .map(({ alias }) => alias),
        };
      }),
    };
  } catch {
    return { status: 'unknown' };
  }
}

/** Settings as Settings reads them: the whole card's, or only the model choices after a change. */
function settingsResponse(body: BuilderModelSettings & { canManage?: boolean; keys?: GatewayKeysStatus }): Response {
  return Response.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
}

/** A model's name for a message: Pi's for a model it lists, else one made from the id. */
function defaultModelLabel(modelId: string): string {
  return isBuilderModelId(modelId) ? knownModelLabel(modelId) : modelIdLabel(modelId);
}

/** A choice the default model rules out; the card reloads the settings to show what stands. */
function modelsRefused(error: string): Response {
  return Response.json({ error }, { status: 409, headers: { 'Cache-Control': 'private, no-store' } });
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
