import { findMembership } from '~/lib/cloudflare/data/organization-access.server';
import { readAiGatewayContentLogging } from '~/lib/cloudflare/data/ai-gateway-logging.server';
import { z } from 'zod';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { linkedGatewayKeys } from '~/lib/.server/cloudflare/ai-gateway-keys';
import { readDefaultBuilderModel } from '~/lib/cloudflare/data/builder-model-settings.server';
import { credentialResponse, readAuthenticatedRuntimeRequest } from './runtime-authentication';

const MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES = 4 * 1024;
const runtimeCredentialRequestSchema = z.object({ forceRefresh: z.boolean().optional().default(false) }).strict();

/** Exchange a runtime-specific secret for a freshly resolved OAuth access token. */
export async function runtimeCredentialAction(args: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, runtimeCredentialRequestSchema, {
    maxBytes: MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES,
    label: 'Workspace runtime credential request',
    invalid: 'Invalid workspace runtime credential request.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity } = authenticated;
  // A member who only works on GitHub projects reaches production through GitHub alone: their
  // workspace is never handed the organization's Cloudflare authorization.
  if (authenticated.connection.orgId) {
    const membership = await findMembership(args.env.DB, authenticated.connection.orgId, identity.userId);
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
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, runtimeUsageRequestSchema, {
    maxBytes: MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES,
    label: 'Workspace runtime usage report',
    invalid: 'Invalid workspace runtime usage report.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity } = authenticated;
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
      .bind(orgId, identity.userId, day, body.inputTokens, body.outputTokens, body.cachedTokens)
      .run();
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

const runtimeAccessRequestSchema = z.strictObject({});

/**
 * Whether a workspace runtime's person may still build, and whether their model requests may be logged
 * with their content in the account's AI Gateway: asked before each model request. In an organization's
 * account, whose Workers AI the organization pays for, pausing or removing a member stops their next
 * turn even in a workspace they already have open.
 */
export async function runtimeAccessAction(args: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, runtimeAccessRequestSchema, {
    maxBytes: MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES,
    label: 'Workspace runtime access check',
    invalid: 'Invalid workspace runtime access check.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { identity } = authenticated;
  // An organization's admins may use its Cloudflare authorization directly (the agent's Cloudflare tool).
  const orgId = authenticated.connection.orgId;
  const membership = orgId ? await findMembership(args.env.DB, orgId, identity.userId) : null;
  return Response.json(
    {
      organizationAdmin: membership?.role === 'admin' && membership.pausedAt === null,
      // The person's own choice, wherever they build: a team's admins can't turn it back on for them.
      aiGatewayContentLogging: await readAiGatewayContentLogging(args.env.DB, identity.userId),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * A workspace runtime asking about its account's models, for the picker's catalog and before a
 * gateway provider's turn: the default its admin chose, and the provider keys its default AI Gateway
 * holds (each provider's, with the alias its requests name), asked of Cloudflare each time so a key
 * removed in the dashboard stops its provider's models at once.
 */
export async function runtimeModelsAction(args: {
  request: Request;
  env: Env;
  gatewayKeys?: typeof linkedGatewayKeys;
}): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, runtimeAccessRequestSchema, {
    maxBytes: MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES,
    label: 'Workspace runtime model check',
    invalid: 'Invalid workspace runtime model check.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { connection } = authenticated;
  const [defaultModelId, gatewayKeys] = await Promise.all([
    readDefaultBuilderModel(args.env.DB, connection.id),
    (args.gatewayKeys ?? linkedGatewayKeys)(args.env, connection),
  ]);
  return Response.json({ defaultModelId, gatewayKeys }, { headers: { 'Cache-Control': 'no-store' } });
}
