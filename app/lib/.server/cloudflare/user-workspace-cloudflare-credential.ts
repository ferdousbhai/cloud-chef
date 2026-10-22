import { z } from 'zod';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import type { CloudflareAccessTokenResolution } from './cloudflare-api-client';
import {
  runtimeIdentity,
  type CloudflareApiRuntimeEnv,
  type CloudflareApiRuntimeIdentity,
} from './cloudflare-api-runtime-identity';
import type { ModelTurnUsage } from '~/lib/.server/llm/workers-ai-telemetry';
import { gatewayKeysSchema, NO_ACCOUNT_MODEL_SETTINGS, type AccountModelSettings } from '~/lib/workers-ai-model';
import { runtimeIdentityHeaders } from './runtime-identity-headers';
import { CLOUDCHEF_CONTROL_PLANE_ENDPOINT } from './user-workspace-runtime-policy';

const RUNTIME_ROUTE_TIMEOUT_MS = 30_000;
const MAX_RUNTIME_CREDENTIAL_RESPONSE_BYTES = 8 * 1024;
const runtimeCredentialResponseSchema = z.object({ accessToken: z.string().min(1).max(4_096) }).strict();

type CloudflareConnectionIdentity = Pick<
  CloudflareApiRuntimeIdentity,
  'userId' | 'connectionId' | 'connectionGeneration'
>;

const tokenWithheldSchema = z.object({ code: z.literal('cloudflare_token_withheld'), error: z.string() });

type RuntimeCredentialEnv = Pick<Env, 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT' | 'CONTROL_PLANE_SECRET'>;

/** Whether this runtime can reach its credential broker: the pinned control plane, with the runtime's secret. */
export function runtimeCredentialBrokerConfigured(env: RuntimeCredentialEnv): boolean {
  return env.CLOUDCHEF_CONTROL_PLANE_ENDPOINT === CLOUDCHEF_CONTROL_PLANE_ENDPOINT && Boolean(env.CONTROL_PLANE_SECRET);
}

/**
 * Resolve an access token through the authenticated control-plane broker without retaining it. Only the
 * pinned control plane is asked, and only its direct, non-cacheable answer is taken.
 */
export async function resolveUserWorkspaceCloudflareAccessToken(
  env: RuntimeCredentialEnv,
  identity: CloudflareConnectionIdentity,
  options: CloudflareAccessTokenResolution = {},
): Promise<string> {
  if (!runtimeCredentialBrokerConfigured(env)) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  const response = await postRuntimeRoute(env, identity, 'runtime-credential', {
    forceRefresh: options.forceRefresh === true,
  });
  if (!response.ok && response.status !== 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Cloudflare connection is unavailable.');
  }
  const body = await readJsonBodyWithLimit(
    response,
    MAX_RUNTIME_CREDENTIAL_RESPONSE_BYTES,
    'Runtime credential response',
  ).catch(() => null);
  if (!response.ok) {
    // Said plainly: the member works on the organization's GitHub projects only, so drafts can't deploy.
    const withheld = tokenWithheldSchema.safeParse(body);
    throw new Error(withheld.success ? withheld.data.error : 'Cloudflare connection is unavailable.');
  }
  const parsed = runtimeCredentialResponseSchema.safeParse(body);
  if (!parsed.success || !containsNoStore(response.headers.get('Cache-Control') ?? '')) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  return parsed.data.accessToken;
}

function containsNoStore(value: string): boolean {
  return value
    .toLowerCase()
    .split(',')
    .some((directive) => directive.trim() === 'no-store');
}

/**
 * Reports one finished model turn's token counts to the control plane, which keeps them for an
 * organization's admins. Best-effort: usage accounting never holds up or fails a turn.
 */
export async function reportUserWorkspaceModelUsage(
  env: RuntimeCredentialEnv,
  identity: CloudflareConnectionIdentity,
  usage: ModelTurnUsage,
): Promise<void> {
  const response = await postRuntimeRoute(env, identity, 'runtime-usage', usage);
  await response.body?.cancel().catch(() => undefined);
}

/** What the control plane says about this runtime's person, asked before each model request. */
export type UserWorkspaceAccess = {
  /** Whether they are an active admin of the organization whose account this is. */
  organizationAdmin: boolean;
  /** Whether their model requests may be logged with their content in the account's AI Gateway. */
  aiGatewayContentLogging: boolean;
};

export type ConfirmUserWorkspaceAccess = (
  env: RuntimeCredentialEnv,
  identity: CloudflareConnectionIdentity,
) => Promise<UserWorkspaceAccess | null>;

/**
 * Whether this person may still use the runtime's account (null once they are paused or removed from
 * the organization that owns the connection), and what they may do there. Errors, like an unreachable
 * control plane, are thrown, not read as a refusal.
 */
export const confirmUserWorkspaceAccess: ConfirmUserWorkspaceAccess = async (env, identity) => {
  const response = await postRuntimeRoute(env, identity, 'runtime-access');
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The CloudChef control plane could not confirm workspace access.');
  }
  const parsed = accessResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : { organizationAdmin: false, aiGatewayContentLogging: false };
};

// Anything the control plane leaves out is read as the narrower answer: not an admin, and, since a
// person's opt-out must hold, not logged.
const accessResponseSchema = z.object({
  organizationAdmin: z.boolean().catch(false),
  aiGatewayContentLogging: z.boolean().catch(false),
});

type ModelRequestAccess =
  | { allowed: false }
  | {
      allowed: true;
      /** Whether this request may be logged with its content in the account's AI Gateway. */
      contentLogging: boolean;
      /** Counts the request toward an organization member's usage; null elsewhere. */
      report: ((usage: ModelTurnUsage) => Promise<void>) | null;
    };

/**
 * Asked before each model request. In an organization's account it is refused once the member is
 * paused or removed, and counted toward their usage; elsewhere it is always allowed and not counted
 * (only organizations keep per-member usage). Either way the person's own choice decides whether
 * the request's content is logged in the account's AI Gateway, and when that can't be learned (no
 * runtime identity, an unreachable control plane), it isn't logged.
 */
export async function modelRequestAccess(
  env: RuntimeCredentialEnv & CloudflareApiRuntimeEnv,
  confirm: ConfirmUserWorkspaceAccess = confirmUserWorkspaceAccess,
): Promise<ModelRequestAccess> {
  const organization = env.CLOUDCHEF_SHARED_ACCOUNT === '1';
  const identity = runtimeIdentity(env);
  if (!identity) {
    return organization ? { allowed: false } : { allowed: true, contentLogging: false, report: null };
  }
  if (!organization) {
    const access = await confirm(env, identity).catch(() => null);
    return { allowed: true, contentLogging: access?.aiGatewayContentLogging === true, report: null };
  }
  const access = await confirm(env, identity);
  if (!access) {
    return { allowed: false };
  }
  return {
    allowed: true,
    contentLogging: access.aiGatewayContentLogging,
    report: (usage) => reportUserWorkspaceModelUsage(env, identity, usage),
  };
}

const accountModelSettingsSchema = z.object({
  defaultModelId: z.string().min(1).max(256).nullable().catch(null),
  gatewayKeys: gatewayKeysSchema.catch([]),
});

/**
 * The account's model settings, asked by the runtime for the picker's catalog and before a gateway
 * provider's turn: the default its admin chose, and the provider keys its default AI Gateway holds.
 * Anything unlearnable (no runtime identity, an unreachable control plane, a refusal) reads as no
 * chosen default and no keys: a provider's model runs only with a key the control plane confirmed.
 */
export async function readAccountModelSettings(
  env: RuntimeCredentialEnv & CloudflareApiRuntimeEnv,
): Promise<AccountModelSettings> {
  const identity = runtimeIdentity(env);
  if (!identity) {
    return NO_ACCOUNT_MODEL_SETTINGS;
  }
  try {
    const response = await postRuntimeRoute(env, identity, 'runtime-models');
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return NO_ACCOUNT_MODEL_SETTINGS;
    }
    const parsed = accountModelSettingsSchema.safeParse(
      await readJsonBodyWithLimit(response, MAX_RUNTIME_CREDENTIAL_RESPONSE_BYTES, 'Account model settings'),
    );
    return parsed.success ? parsed.data : NO_ACCOUNT_MODEL_SETTINGS;
  } catch {
    return NO_ACCOUNT_MODEL_SETTINGS;
  }
}

/** A file a linked project's commit writes (with its content) or deletes (without). */
export type RuntimeFileChange = { path: string; contentBase64: string | null; executable: boolean };

/** The fields a runtime route is sent. */
type RuntimeRouteBody = Record<string, string | number | boolean | null | undefined | RuntimeFileChange[]>;

/**
 * A call to one of the control plane's runtime routes, as this runtime, carrying `body` as JSON (a field
 * left undefined is not sent).
 */
export function postRuntimeRoute(
  env: RuntimeCredentialEnv,
  identity: CloudflareConnectionIdentity,
  route: RuntimeRoute,
  body: RuntimeRouteBody = {},
  timeoutMs = RUNTIME_ROUTE_TIMEOUT_MS,
): Promise<Response> {
  return fetch(runtimeRouteEndpoint(env.CLOUDCHEF_CONTROL_PLANE_ENDPOINT, route), {
    method: 'POST',
    headers: runtimeRequestHeaders(env, identity),
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * What every call to the control plane's runtime routes carries: the runtime's secret, and who it says
 * it is, in headers, so the control plane checks them before reading the body.
 */
function runtimeRequestHeaders(env: RuntimeCredentialEnv, identity: CloudflareConnectionIdentity) {
  return {
    authorization: `Bearer ${env.CONTROL_PLANE_SECRET}`,
    'content-type': 'application/json',
    ...runtimeIdentityHeaders(identity),
  };
}

/** The control plane's runtime-facing routes, authenticated with the runtime's own secret. */
type RuntimeRoute =
  | 'runtime-credential'
  | 'runtime-usage'
  | 'runtime-access'
  | 'runtime-models'
  | 'runtime-github/snapshot'
  | 'runtime-github/commit'
  | 'runtime-github/status'
  | 'runtime-github/site'
  | 'runtime-github/request-production';

function runtimeRouteEndpoint(value: string, route: RuntimeRoute): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(`/api/cloudflare/${route}`, value);
  } catch {
    throw new Error('The CloudChef control-plane endpoint is invalid.');
  }
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
    throw new Error('The CloudChef control-plane endpoint must use HTTPS.');
  }
  return endpoint;
}
