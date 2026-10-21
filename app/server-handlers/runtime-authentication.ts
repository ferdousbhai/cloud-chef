import { z } from 'zod';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';
import { canUseConnection } from '~/lib/cloudflare/data/organization-access.server';
import {
  findActiveCloudflareConnection,
  type CloudflareConnection,
} from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { readRuntimeIdentityHeaders, type RuntimeIdentity } from '~/lib/.server/cloudflare/runtime-identity-headers';

/**
 * The most a runtime that names itself only in its body (one built before the identity headers) may
 * send: such a body is read before the runtime is authenticated, so it stays small. A runtime naming
 * itself in headers is authenticated first, and only then is its body read.
 */
const MAX_UNAUTHENTICATED_BODY_BYTES = 64 * 1024;

/** The identity a body may still carry, as runtimes built before the identity headers send it. */
export const bodyIdentityFields = {
  userId: z.string().min(1).max(512).optional(),
  connectionId: z.string().min(1).max(512).optional(),
  connectionGeneration: z.number().int().positive().optional(),
};

type AuthenticatedRuntimeRequest<T> = {
  body: T;
  identity: RuntimeIdentity;
  connection: CloudflareConnection;
  credentialHandle: string;
};

/**
 * A runtime route's request, once the runtime has proven who it is. A runtime names itself in headers
 * (`runtimeIdentityHeaders`) and is authenticated before its body, up to `maxBytes`, is read; one built
 * before those headers names itself in the body, which is then read only up to 64 KB first. A body
 * naming anyone other than the headers is refused.
 */
export async function readAuthenticatedRuntimeRequest<T extends Partial<RuntimeIdentity>>(
  env: Env,
  request: Request,
  schema: z.ZodType<T>,
  options: { maxBytes: number; label: string; invalid: string },
): Promise<AuthenticatedRuntimeRequest<T> | Response> {
  const named = readRuntimeIdentityHeaders(request.headers);
  if (named === 'invalid') {
    return credentialResponse({ error: options.invalid }, 400);
  }
  if (named) {
    const authenticated = await authenticateRuntime(env, request, named);
    if (authenticated instanceof Response) {
      return authenticated;
    }
    const body = await readRuntimeBody(request, schema, options.maxBytes, options);
    if (body instanceof Response) {
      return body;
    }
    if (
      (body.userId !== undefined && body.userId !== named.userId) ||
      (body.connectionId !== undefined && body.connectionId !== named.connectionId) ||
      (body.connectionGeneration !== undefined && body.connectionGeneration !== named.connectionGeneration)
    ) {
      return credentialResponse({ error: options.invalid }, 400);
    }
    return { body, identity: named, ...authenticated };
  }
  const body = await readRuntimeBody(
    request,
    schema,
    Math.min(options.maxBytes, MAX_UNAUTHENTICATED_BODY_BYTES),
    options,
  );
  if (body instanceof Response) {
    return body;
  }
  const { userId, connectionId, connectionGeneration } = body;
  if (userId === undefined || connectionId === undefined || connectionGeneration === undefined) {
    return credentialResponse({ error: options.invalid }, 400);
  }
  const identity = { userId, connectionId, connectionGeneration };
  const authenticated = await authenticateRuntime(env, request, identity);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  return { body, identity, ...authenticated };
}

async function readRuntimeBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number,
  options: { label: string; invalid: string },
): Promise<T | Response> {
  try {
    return schema.parse(await readJsonBodyWithLimit(request, maxBytes, options.label));
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

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function credentialResponse(body: Record<string, string>, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
