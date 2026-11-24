import { findMembership, isActiveAdmin, type Membership } from '~/lib/cloudflare/data/organization-access.server';
import { billingConfig } from '~/lib/.server/billing/stripe';
import { allowanceUsed, spaceUsage } from '~/lib/cloudflare/data/managed-subscriptions.server';
import { ALLOWANCE_USED_MESSAGE } from '~/lib/managed-space';
import { readAiGatewayContentLogging } from '~/lib/cloudflare/data/ai-gateway-logging.server';
import { z } from 'zod';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { linkedGatewayKeys } from '~/lib/.server/cloudflare/ai-gateway-keys';
import { readBuilderModelSettings } from '~/lib/cloudflare/data/builder-model-settings.server';
import { credentialResponse, readAuthenticatedRuntimeRequest } from './runtime-authentication';
import { memberIdentity } from './runtime-projects';

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
        { code: 'cloudflare_token_withheld', error: 'Your team lets you work on its team projects only.' },
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

const runtimeUsageRequestSchema = z.union([
  z
    .object({
      inputTokens: z.number().int().min(0).max(100_000_000),
      outputTokens: z.number().int().min(0).max(100_000_000),
      cachedTokens: z.number().int().min(0).max(100_000_000),
    })
    .strict(),
  // A stretch of the workspace container's running time: at most a day, however late it is reported.
  z.object({ containerSeconds: z.number().int().min(0).max(86_400) }).strict(),
]);

/**
 * A workspace runtime reporting one finished model turn's token counts, or how long its workspace
 * container has run since it last said. Recorded only for an organization's account, where admins see
 * each member's use and a space CloudChef runs is held to its allowance; counts only, never content.
 */
export async function runtimeUsageAction(args: { request: Request; env: Env }): Promise<Response> {
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
  const day = new Date().toISOString().slice(0, 10);
  if (!orgId) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  if ('containerSeconds' in body) {
    await args.env.DB.prepare(
      `INSERT INTO organization_usage_daily (org_id, user_id, day, container_seconds) VALUES (?, ?, ?, ?)
       ON CONFLICT(org_id, user_id, day) DO UPDATE SET
         container_seconds = container_seconds + excluded.container_seconds`,
    )
      .bind(orgId, identity.userId, day, body.containerSeconds)
      .run();
  } else {
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
      organizationAdmin: isActiveAdmin(membership),
      // The person's own choice, wherever they build: a team's admins can't turn it back on for them.
      aiGatewayContentLogging: await readAiGatewayContentLogging(args.env.DB, identity.userId),
      // Who the person is, as the commits made in their name say.
      member: await memberIdentity(args.env.DB, identity.userId),
      modelRefusal:
        orgId && membership && !isActiveAdmin(membership)
          ? await allowanceRefusal(args.env, authenticated.connection.id, membership, identity.userId)
          : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Why someone can't make another model request this month: the allowance is used up, and any credit bought. A space CloudChef runs
 * has one allowance for everyone in it; in the host team, where spaces were first given as memberships, each
 * member has their own. Null for any other team, and while there is allowance left.
 */
async function allowanceRefusal(
  env: Env,
  connectionId: string,
  membership: Membership,
  userId: string,
): Promise<string | null> {
  if (!membership.managed && billingConfig(env)?.managedOrgId !== membership.orgId) {
    return null;
  }
  const usage = await spaceUsage(env.DB, connectionId, membership.orgId, membership.managed ? null : userId);
  if (!allowanceUsed(usage)) {
    return null;
  }
  const resets = new Date(usage.resetsAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  // Credit is bought by whoever subscribes to the space: its admin.
  const next = !membership.managed
    ? `It starts again on ${resets}.`
    : membership.role === 'admin'
      ? `Add credit in Settings to keep building now, or wait until it starts again on ${resets}.`
      : `Whoever runs the space can add credit in Settings, or it starts again on ${resets}.`;
  return `${ALLOWANCE_USED_MESSAGE}. ${next} What you published keeps running.`;
}

/**
 * A workspace runtime asking about its account's models, for the picker's catalog and before every
 * turn: the default its admin chose, the models its admin allows (null for every compatible one), and
 * the provider keys its default AI Gateway holds (each provider's, with the alias its requests name),
 * asked of Cloudflare each time so a key removed in the dashboard stops its provider's models at once.
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
  const [{ defaultModelId, allowedModelIds }, gatewayKeys] = await Promise.all([
    readBuilderModelSettings(args.env.DB, connection.id),
    (args.gatewayKeys ?? linkedGatewayKeys)(args.env, connection),
  ]);
  return Response.json({ defaultModelId, gatewayKeys, allowedModelIds }, { headers: { 'Cache-Control': 'no-store' } });
}
