import { z } from 'zod';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import type { CloudflareAccessTokenResolution } from './cloudflare-api-client';
import { runtimeIdentity, type CloudflareApiRuntimeIdentity } from './cloudflare-api-runtime-controls';
import type { ModelTurnUsage } from '~/lib/.server/llm/workers-ai-telemetry';

const RUNTIME_CREDENTIAL_TIMEOUT_MS = 30_000;
const MAX_RUNTIME_CREDENTIAL_RESPONSE_BYTES = 8 * 1024;
const runtimeCredentialResponseSchema = z.object({ accessToken: z.string().min(1).max(4_096) }).strict();

type CloudflareConnectionIdentity = Pick<
  CloudflareApiRuntimeIdentity,
  'userId' | 'connectionId' | 'connectionGeneration'
>;

type RuntimeCredentialEnv = Pick<Env, 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT' | 'CONTROL_PLANE_SECRET'>;

/** Resolve an access token through the authenticated control-plane broker without retaining it. */
export async function resolveUserWorkspaceCloudflareAccessToken(
  env: RuntimeCredentialEnv,
  identity: CloudflareConnectionIdentity,
  options: CloudflareAccessTokenResolution = {},
): Promise<string> {
  const endpoint = runtimeCredentialEndpoint(env.CLOUDCHEF_CONTROL_PLANE_ENDPOINT);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CONTROL_PLANE_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      userId: identity.userId,
      connectionId: identity.connectionId,
      connectionGeneration: identity.connectionGeneration,
      forceRefresh: options.forceRefresh === true,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(RUNTIME_CREDENTIAL_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The Cloudflare credential broker rejected this runtime.');
  }
  const parsed = runtimeCredentialResponseSchema.safeParse(
    await readJsonBodyWithLimit(response, MAX_RUNTIME_CREDENTIAL_RESPONSE_BYTES, 'Runtime credential response'),
  );
  if (!parsed.success) {
    throw new Error('The Cloudflare credential broker returned an invalid response.');
  }
  return parsed.data.accessToken;
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
  const response = await fetch(runtimeCredentialEndpoint(env.CLOUDCHEF_CONTROL_PLANE_ENDPOINT, 'runtime-usage'), {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CONTROL_PLANE_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: identity.userId,
      connectionId: identity.connectionId,
      connectionGeneration: identity.connectionGeneration,
      ...usage,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(RUNTIME_CREDENTIAL_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Whether the control plane still lets this runtime's person build: false once they are paused or
 * removed from the organization that owns the connection. Errors, like an unreachable control plane,
 * are thrown, not read as a refusal.
 */
export async function confirmUserWorkspaceAccess(
  env: RuntimeCredentialEnv,
  identity: CloudflareConnectionIdentity,
): Promise<boolean> {
  const response = await fetch(runtimeCredentialEndpoint(env.CLOUDCHEF_CONTROL_PLANE_ENDPOINT, 'runtime-access'), {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CONTROL_PLANE_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: identity.userId,
      connectionId: identity.connectionId,
      connectionGeneration: identity.connectionGeneration,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(RUNTIME_CREDENTIAL_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401) {
    return false;
  }
  if (!response.ok) {
    throw new Error('The CloudChef control plane could not confirm workspace access.');
  }
  return true;
}

/**
 * Model calls outside a builder turn (prompt enhancement) in an organization's account: refused once
 * the member is paused or removed, and counted toward their usage. Elsewhere, always allowed and not
 * counted (only organizations keep per-member usage).
 */
export async function organizationModelAccess(
  env: RuntimeCredentialEnv & Parameters<typeof runtimeIdentity>[0],
): Promise<{ allowed: false } | { allowed: true; report: ((usage: ModelTurnUsage) => Promise<void>) | null }> {
  if (env.CLOUDCHEF_SHARED_ACCOUNT !== '1') {
    return { allowed: true, report: null };
  }
  const identity = runtimeIdentity(env);
  if (!identity || !(await confirmUserWorkspaceAccess(env, identity))) {
    return { allowed: false };
  }
  return { allowed: true, report: (usage) => reportUserWorkspaceModelUsage(env, identity, usage) };
}

function runtimeCredentialEndpoint(
  value: string,
  route: 'runtime-credential' | 'runtime-usage' | 'runtime-access' = 'runtime-credential',
): URL {
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
