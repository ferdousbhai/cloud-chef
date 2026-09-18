import { z } from 'zod';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import type { CloudflareMcpAccessTokenResolution, CloudflareMcpIdentity } from './cloudflare-mcp-client';

const RUNTIME_CREDENTIAL_TIMEOUT_MS = 30_000;
const MAX_RUNTIME_CREDENTIAL_RESPONSE_BYTES = 8 * 1024;
const runtimeCredentialResponseSchema = z.object({ accessToken: z.string().min(1).max(4_096) }).strict();

type RuntimeCredentialEnv = Pick<Env, 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT' | 'CONTROL_PLANE_SECRET'>;

/** Resolve an access token through the authenticated control-plane broker without retaining it. */
export async function resolveUserWorkspaceCloudflareAccessToken(
  env: RuntimeCredentialEnv,
  identity: CloudflareMcpIdentity,
  options: CloudflareMcpAccessTokenResolution = {},
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

function runtimeCredentialEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL('/api/cloudflare/runtime-credential', value);
  } catch {
    throw new Error('The CloudChef control-plane endpoint is invalid.');
  }
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
    throw new Error('The CloudChef control-plane endpoint must use HTTPS.');
  }
  return endpoint;
}
