import { canUseConnection, findMembership } from '~/lib/cloudflare/data/organization-access.server';
import { readAiGatewayContentLogging } from '~/lib/cloudflare/data/ai-gateway-logging.server';
import { z } from 'zod';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';
import {
  findActiveCloudflareConnection,
  type CloudflareConnection,
} from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { isClaudeLinked } from '~/lib/.server/cloudflare/ai-gateway-claude';
import { readDefaultBuilderModel } from '~/lib/cloudflare/data/builder-model-settings.server';

const MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES = 4 * 1024;
const runtimeCredentialRequestSchema = z
  .object({
    userId: z.string().min(1).max(512),
    connectionId: z.string().min(1).max(512),
    connectionGeneration: z.number().int().positive(),
    forceRefresh: z.boolean().optional().default(false),
  })
  .strict();

/** Exchange a runtime-specific secret for a freshly resolved OAuth access token. */
export async function runtimeCredentialAction(args: { request: Request; env: Env }): Promise<Response> {
  let body: z.infer<typeof runtimeCredentialRequestSchema>;
  try {
    body = runtimeCredentialRequestSchema.parse(
      await readJsonBodyWithLimit(
        args.request,
        MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES,
        'Workspace runtime credential request',
      ),
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return credentialResponse({ error: error.message }, 413);
    }
    if (error instanceof InvalidJsonBodyError || error instanceof z.ZodError) {
      return credentialResponse({ error: 'Invalid workspace runtime credential request.' }, 400);
    }
    throw error;
  }

  const authenticated = await authenticateRuntime(args.env, args.request, body);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  // A member who only works on GitHub projects reaches production through GitHub alone: their
  // workspace is never handed the organization's Cloudflare authorization.
  if (authenticated.connection.orgId) {
    const membership = await findMembership(args.env.DB, authenticated.connection.orgId, body.userId);
    if (!membership?.draftsAllowed) {
      return credentialResponse(
        { code: 'cloudflare_token_withheld', error: 'Your team lets you work on its GitHub projects only.' },
        403,
      );
    }
  }
  try {
    const accessToken = await D1CloudflareCredentialVault.fromEnv(args.env).resolve(authenticated.credentialHandle, {
      forceRefresh: body.forceRefresh,
    });
    return credentialResponse({ accessToken }, 200);
  } catch {
    console.error('Unable to resolve the user workspace runtime credential');
    return credentialResponse({ error: 'Cloudflare connection is unavailable.' }, 503);
  }
}

const runtimeUsageRequestSchema = z
  .object({
    userId: z.string().min(1).max(512),
    connectionId: z.string().min(1).max(512),
    connectionGeneration: z.number().int().positive(),
    inputTokens: z.number().int().min(0).max(100_000_000),
    outputTokens: z.number().int().min(0).max(100_000_000),
    cachedTokens: z.number().int().min(0).max(100_000_000),
  })
  .strict();

/**
 * A workspace runtime reporting one finished model turn's token counts. Recorded only for an
 * organization's account, where admins see each member's use; counts only, never content.
 */
export async function runtimeUsageAction(args: { request: Request; env: Env; now?: number }): Promise<Response> {
  let body: z.infer<typeof runtimeUsageRequestSchema>;
  try {
    body = runtimeUsageRequestSchema.parse(
      await readJsonBodyWithLimit(args.request, MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES, 'Workspace runtime usage report'),
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError || error instanceof InvalidJsonBodyError || error instanceof z.ZodError) {
      return credentialResponse({ error: 'Invalid workspace runtime usage report.' }, 400);
    }
    throw error;
  }
  const authenticated = await authenticateRuntime(args.env, args.request, body);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const orgId = authenticated.connection.orgId;
  if (orgId) {
    const day = new Date(args.now ?? Date.now()).toISOString().slice(0, 10);
    await args.env.DB.prepare(
      `INSERT INTO organization_usage_daily (org_id, user_id, day, turns, input_tokens, output_tokens, cached_tokens)
       VALUES (?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(org_id, user_id, day) DO UPDATE SET
         turns = turns + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cached_tokens = cached_tokens + excluded.cached_tokens`,
    )
      .bind(orgId, body.userId, day, body.inputTokens, body.outputTokens, body.cachedTokens)
      .run();
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

const runtimeAccessRequestSchema = z
  .object({
    userId: z.string().min(1).max(512),
    connectionId: z.string().min(1).max(512),
    connectionGeneration: z.number().int().positive(),
  })
  .strict();

/**
 * Whether a workspace runtime's person may still build, and whether their model requests may be logged
 * with their content in the account's AI Gateway: asked before each model request. In an organization's
 * account, whose Workers AI the organization pays for, pausing or removing a member stops their next
 * turn even in a workspace they already have open.
 */
export async function runtimeAccessAction(args: { request: Request; env: Env }): Promise<Response> {
  let body: z.infer<typeof runtimeAccessRequestSchema>;
  try {
    body = runtimeAccessRequestSchema.parse(
      await readJsonBodyWithLimit(args.request, MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES, 'Workspace runtime access check'),
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError || error instanceof InvalidJsonBodyError || error instanceof z.ZodError) {
      return credentialResponse({ error: 'Invalid workspace runtime access check.' }, 400);
    }
    throw error;
  }
  const authenticated = await authenticateRuntime(args.env, args.request, body);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  // An organization's admins may use its Cloudflare authorization directly (the agent's Cloudflare tool).
  const orgId = authenticated.connection.orgId;
  const membership = orgId ? await findMembership(args.env.DB, orgId, body.userId) : null;
  return Response.json(
    {
      organizationAdmin: membership?.role === 'admin' && membership.pausedAt === null,
      // The person's own choice, wherever they build: a team's admins can't turn it back on for them.
      aiGatewayContentLogging: await readAiGatewayContentLogging(args.env.DB, body.userId),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * A workspace runtime asking about its account's models, for the picker's catalog and before a Claude
 * turn: the default its admin chose, and whether its default AI Gateway holds an Anthropic key, asked
 * of Cloudflare each time so a key removed in the dashboard stops Claude at once.
 */
export async function runtimeModelsAction(args: {
  request: Request;
  env: Env;
  claudeLinked?: typeof isClaudeLinked;
}): Promise<Response> {
  let body: z.infer<typeof runtimeAccessRequestSchema>;
  try {
    body = runtimeAccessRequestSchema.parse(
      await readJsonBodyWithLimit(args.request, MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES, 'Workspace runtime model check'),
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError || error instanceof InvalidJsonBodyError || error instanceof z.ZodError) {
      return credentialResponse({ error: 'Invalid workspace runtime model check.' }, 400);
    }
    throw error;
  }
  const authenticated = await authenticateRuntime(args.env, args.request, body);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { connection } = authenticated;
  const [defaultModelId, claude] = await Promise.all([
    readDefaultBuilderModel(args.env.DB, connection.id),
    (args.claudeLinked ?? isClaudeLinked)(args.env, connection),
  ]);
  return Response.json({ defaultModelId, claude }, { headers: { 'Cache-Control': 'no-store' } });
}

type RuntimeIdentity = { userId: string; connectionId: string; connectionGeneration: number };

/**
 * A workspace runtime proving who it is: its secret, derived from the person, the account and the
 * connection generation, must match, and only then is the person asked about: they must still be the
 * connection's owner, or an unpaused member of the organization that owns it. Pausing or removing
 * them stops their runtime at its very next call.
 */
export async function authenticateRuntime(
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

function credentialResponse(body: Record<string, string>, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
