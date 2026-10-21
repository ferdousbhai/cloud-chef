import { z } from 'zod';
import { getAuthSession, type CloudflareAuthSession } from '~/lib/.server/auth';
import { hasSameOrigin, readJsonRequest } from '~/lib/.server/request-guards';
import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import {
  ANTHROPIC_PROVIDER_SLUG,
  canManageAiGatewayKeys,
  CLAUDE_GATEWAY_ID,
  findClaudeKey,
  linkableSecretAlias,
  openClaudeKeyAccountApi,
  type ClaudeKeyAccountApi,
  type OpenClaudeKeyAccountApi,
} from '~/lib/.server/cloudflare/ai-gateway-claude';
import { CloudflareAccountApiError } from '~/lib/.server/cloudflare/user-account-api';
import {
  canManageModels,
  readDefaultBuilderModel,
  setDefaultBuilderModel,
} from '~/lib/cloudflare/data/builder-model-settings.server';
import { builderModelIdSchema } from '~/lib/workers-ai-model';
import { sessionConnection } from './cloudflare-integration';

/**
 * Settings, under Models: the model an account's builders start on, and the Anthropic key that lets
 * them use Claude, stored in the account's own Secrets Store and attached to its default AI Gateway.
 * A team's admins (or the person whose own account it is) choose both; everyone else sees them and
 * can still switch models in the picker. The key goes from the browser to Cloudflare once and is never
 * kept, logged, or returned by CloudChef.
 */

type ClaudeStatus =
  | { status: 'linked'; alias: string; secretPreview: string | null }
  | { status: 'unlinked' }
  /** The connection was authorized before CloudChef could manage AI Gateway keys. */
  | { status: 'reauthorization_required' }
  /** Cloudflare could not be asked just now. */
  | { status: 'unknown' };

type LinkableSecret = { id: string; name: string; alias: string | null };

type Context = {
  session: CloudflareAuthSession;
  connection: CloudflareConnection;
  canManage: boolean;
};

type Deps = { openAccountApi?: OpenClaudeKeyAccountApi };

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

/** The account's models as Settings shows them; the Secrets Store secrets only to who can link one. */
export function modelSettingsAction({ request, env, openAccountApi = openClaudeKeyAccountApi }: RequestArgs & Deps) {
  return withContext(request, env, async ({ connection, canManage }) => {
    const defaultModelId = await readDefaultBuilderModel(env.DB, connection.id);
    if (!canManageAiGatewayKeys(connection)) {
      return settingsResponse({
        canManage,
        defaultModelId,
        claude: { status: 'reauthorization_required' },
        secrets: [],
      });
    }
    let api: ClaudeKeyAccountApi;
    try {
      api = await openAccountApi(env, connection);
    } catch {
      return settingsResponse({ canManage, defaultModelId, claude: { status: 'unknown' }, secrets: [] });
    }
    const [claude, secrets] = await Promise.all([
      claudeStatus(api),
      canManage ? linkableSecrets(api) : Promise.resolve([]),
    ]);
    return settingsResponse({ canManage, defaultModelId, claude, secrets });
  });
}

const linkSchema = z.union([
  z.strictObject({ secretId: z.string().min(1).max(128) }),
  // Anthropic keys are opaque tokens; this only refuses what cannot be one.
  z.strictObject({ apiKey: z.string().trim().min(20).max(512).regex(/^\S+$/) }),
]);

/**
 * Links an Anthropic key to the account's default gateway: a new key, which Cloudflare stores in the
 * account's Secrets Store, or a Secrets Store secret already there. It replaces any key linked before.
 */
export function linkClaudeKeyAction({ request, env, openAccountApi = openClaudeKeyAccountApi }: RequestArgs & Deps) {
  return withContext(
    request,
    env,
    async ({ connection }) => {
      if (!canManageAiGatewayKeys(connection)) {
        return reauthorizationRequired();
      }
      const body = await readJsonRequest(request, linkSchema, 'Choose a secret, or paste an Anthropic API key.');
      if ('response' in body) {
        return body.response;
      }
      return withAccountApi(env, connection, openAccountApi, async (api) => {
        let key: { alias: string } & ({ secret: string } | { secretId: string });
        if ('secretId' in body.data) {
          const secretId = body.data.secretId;
          const secret = (await api.listAiGatewaySecrets()).find(({ id }) => id === secretId);
          const alias = secret ? linkableSecretAlias(secret.name) : null;
          if (!secret || alias === null) {
            return Response.json(
              {
                error: `AI Gateway finds a key by its secret's name: choose a secret named ${CLAUDE_GATEWAY_ID}_${ANTHROPIC_PROVIDER_SLUG}_default (or another alias after the last underscore), with the AI Gateway scope.`,
              },
              { status: 400 },
            );
          }
          key = { alias, secretId };
        } else {
          key = { alias: 'default', secret: body.data.apiKey };
        }
        await removeClaudeKeys(api);
        await api.addAiGatewayProviderKey(CLAUDE_GATEWAY_ID, { providerSlug: ANTHROPIC_PROVIDER_SLUG, ...key });
        return statusResponse(await claudeStatus(api));
      });
    },
    { manage: true },
  );
}

/** Removes the account's Anthropic key from its default gateway, so Claude is no longer offered there. */
export function unlinkClaudeKeyAction({ request, env, openAccountApi = openClaudeKeyAccountApi }: RequestArgs & Deps) {
  return withContext(
    request,
    env,
    async ({ connection }) => {
      if (!canManageAiGatewayKeys(connection)) {
        return reauthorizationRequired();
      }
      return withAccountApi(env, connection, openAccountApi, async (api) => {
        await removeClaudeKeys(api);
        return statusResponse(await claudeStatus(api));
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
  open: OpenClaudeKeyAccountApi,
  operation: (api: ClaudeKeyAccountApi) => Promise<Response>,
): Promise<Response> {
  try {
    return await operation(await open(env, connection));
  } catch (error) {
    // Cloudflare's own refusal is the actionable message (a missing gateway, a store limit); it never
    // carries the key, which goes only in the request body.
    const message =
      error instanceof CloudflareAccountApiError ? error.message : 'Cloudflare could not be reached. Try again.';
    console.warn('Unable to change the account’s Anthropic key');
    return Response.json({ error: message }, { status: 502 });
  }
}

async function removeClaudeKeys(api: ClaudeKeyAccountApi): Promise<void> {
  for (const key of await api.listAiGatewayProviderKeys(CLAUDE_GATEWAY_ID)) {
    if (key.providerSlug === ANTHROPIC_PROVIDER_SLUG) {
      await api.deleteAiGatewayProviderKey(CLAUDE_GATEWAY_ID, key.id);
    }
  }
}

async function claudeStatus(api: ClaudeKeyAccountApi): Promise<ClaudeStatus> {
  try {
    const key = await findClaudeKey(api);
    return key ? { status: 'linked', alias: key.alias, secretPreview: key.secretPreview } : { status: 'unlinked' };
  } catch {
    return { status: 'unknown' };
  }
}

async function linkableSecrets(api: ClaudeKeyAccountApi): Promise<LinkableSecret[]> {
  try {
    return (await api.listAiGatewaySecrets()).map(({ id, name }) => ({ id, name, alias: linkableSecretAlias(name) }));
  } catch {
    return [];
  }
}

function settingsResponse(body: {
  canManage: boolean;
  defaultModelId: string | null;
  claude: ClaudeStatus;
  secrets: LinkableSecret[];
}): Response {
  return Response.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
}

function statusResponse(claude: ClaudeStatus): Response {
  return Response.json({ claude }, { headers: { 'Cache-Control': 'private, no-store' } });
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
