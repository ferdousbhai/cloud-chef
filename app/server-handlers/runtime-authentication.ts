import { z } from 'zod';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';
import { canUseConnection } from '~/lib/cloudflare/data/organization-access.server';
import { constantTimeEqual } from '~/lib/constant-time-equal';
import {
  findActiveCloudflareConnection,
  type CloudflareConnection,
} from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { readRuntimeIdentityHeaders, type RuntimeIdentity } from '~/lib/.server/cloudflare/runtime-identity-headers';

type AuthenticatedRuntimeRequest<T> = {
  body: T;
  identity: RuntimeIdentity;
  connection: CloudflareConnection;
  credentialHandle: string;
};

/**
 * A runtime route's request, once the runtime has proven who it is. A runtime names itself in headers
 * (`runtimeIdentityHeaders`) and is authenticated before its body, up to `maxBytes`, is read.
 */
export async function readAuthenticatedRuntimeRequest<T>(
  env: Env,
  request: Request,
  schema: z.ZodType<T>,
  options: { maxBytes: number; label: string; invalid: string },
): Promise<AuthenticatedRuntimeRequest<T> | Response> {
  const identity = readRuntimeIdentityHeaders(request.headers);
  if (!identity) {
    return credentialResponse({ error: options.invalid }, 400);
  }
  const authenticated = await authenticateRuntime(env, request, identity);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const body = await readRuntimeBody(request, schema, options);
  if (body instanceof Response) {
    return body;
  }
  return { body, identity, ...authenticated };
}

/**
 * A runtime route's request whose body isn't JSON (git's, passed on as it is): the runtime proves who it is from its
 * headers, and the body is left unread.
 */
export async function authenticateRuntimeRequest(
  env: Env,
  request: Request,
): Promise<{ identity: RuntimeIdentity; connection: CloudflareConnection } | Response> {
  const identity = readRuntimeIdentityHeaders(request.headers);
  if (!identity) {
    return credentialResponse({ error: 'Unauthorized.' }, 401);
  }
  const authenticated = await authenticateRuntime(env, request, identity);
  return authenticated instanceof Response ? authenticated : { identity, connection: authenticated.connection };
}

async function readRuntimeBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  options: { maxBytes: number; label: string; invalid: string },
): Promise<T | Response> {
  try {
    return schema.parse(await readJsonBodyWithLimit(request, options.maxBytes, options.label));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return credentialResponse({ error: error.message }, 413);
    }
    if (error instanceof InvalidJsonBodyError || error instanceof z.ZodError) {
      return credentialResponse({ error: options.invalid }, 400);
    }
    throw error;
  }
}

/**
 * A workspace runtime proving who it is: its secret, derived from the person, the account and the
 * connection generation, must match, and only then is the person asked about: they must still be the
 * connection's owner, or an unpaused member of the organization that owns it. Pausing or removing
 * them stops their runtime at its very next call.
 */
async function authenticateRuntime(
  env: Env,
  request: Request,
  identity: RuntimeIdentity,
): Promise<{ connection: CloudflareConnection; credentialHandle: string } | Response> {
  const encryptionKey = env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY;
  const bearer = readBearerToken(request);
  if (!encryptionKey || !bearer) {
    return credentialResponse({ error: 'Unauthorized.' }, 401);
  }
  const connection = await findActiveCloudflareConnection(env.DB, identity.connectionId);
  if (!connection || connection.generation !== identity.connectionGeneration || !connection.credentialHandle) {
    return credentialResponse({ error: 'Unauthorized.' }, 401);
  }
  let expected: string;
  try {
    expected = await deriveUserWorkspaceRuntimeSecret({
      encryptionKeyBase64: encryptionKey,
      userId: identity.userId,
      accountId: connection.accountId,
      connectionGeneration: identity.connectionGeneration,
      organizationConnectionId: connection.orgId ? connection.id : null,
    });
  } catch {
    console.error('Unable to derive the user workspace runtime credential');
    return credentialResponse({ error: 'Cloudflare connection is unavailable.' }, 503);
  }
  if (!constantTimeEqual(bearer, expected) || !(await canUseConnection(env.DB, identity.userId, connection))) {
    return credentialResponse({ error: 'Unauthorized.' }, 401);
  }
  return { connection, credentialHandle: connection.credentialHandle };
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice(7);
  return token.length >= 32 && token.length <= 512 ? token : null;
}

export function credentialResponse(body: Record<string, string>, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
