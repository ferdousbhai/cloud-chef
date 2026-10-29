import { z } from 'zod';
import {
  cloudflareApiRequestSchema,
  cloudflareApiRequestIsRead,
  normalizeCloudflareApiRequest,
  TEAM_APPROVAL_TTL_MS,
  type CloudflareApiRequest,
} from 'cloudchef-agent/cloudflare-api';
import { reviewDomainChange } from '~/agents/cloudflare-domain-review';
import {
  cloudflareExecutionStatusForOutcome,
  safeCloudflareExecutionOutcome,
} from '~/agents/builder-cloudflare-execution';
import { CloudflareApiClient, type CloudflareApiOutcome } from '~/lib/.server/cloudflare/cloudflare-api-client';
import { findActiveCloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { publicOrigin } from '~/lib/.server/public-origin';
import { readJsonRequest } from '~/lib/.server/request-guards';
import { sha256Hex } from '~/lib/hex-digest';
import {
  approvalOutcomeFor,
  claimApproval,
  fileCloudflareChange,
  finishApproval,
  listApprovals,
  rejectApproval,
} from '~/lib/cloudflare/data/approval-requests.server';
import { findMembership } from '~/lib/cloudflare/data/organization-access.server';
import { listPendingProductionRequests } from '~/lib/cloudflare/data/org-projects.server';
import { runtimeFor } from './command-line';
import { json } from './runtime-projects';
import { readAuthenticatedRuntimeRequest } from './runtime-authentication';
import { signedIn } from './signed-in';

type Connection = NonNullable<Awaited<ReturnType<typeof findActiveCloudflareConnection>>>;

/** A client for the account's API with the connection's own authorization, which stays in this Worker. */
function accountClient(env: Env, connection: Connection & { credentialHandle: string }): CloudflareApiClient {
  return new CloudflareApiClient({
    resolveAccessToken: (options) =>
      D1CloudflareCredentialVault.fromEnv(env).resolve(connection.credentialHandle, options),
  });
}

/** GET /api/approvals: what waits for this person as one of their teams' admins, and what was decided lately. */
export function listApprovalsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const { results: teams } = await env.DB.prepare(
      `SELECT organizations.id, organizations.name FROM organization_members AS members
       JOIN organizations ON organizations.id = members.org_id
       WHERE members.user_id = ? AND members.role = 'admin' AND members.paused_at IS NULL
       ORDER BY organizations.name`,
    )
      .bind(session.user.id)
      .all<{ id: string; name: string }>();
    const { waiting, decided } = await listApprovals(env.DB, session.user.id);
    const productionRequests = (
      await Promise.all(
        teams.map(async (team) =>
          (await listPendingProductionRequests(env.DB, team.id)).map((pending) => ({
            id: pending.id,
            orgId: team.id,
            orgName: team.name,
            title: pending.title,
            note: pending.note,
            previewUrl: pending.previewUrl,
            requesterName: pending.requesterName,
            requesterEmail: pending.requesterEmail,
            createdAt: pending.createdAt,
            updatedAt: pending.updatedAt,
          })),
        ),
      )
    ).flat();
    return Response.json({ admin: teams.length > 0, waiting, decided, productionRequests });
  });
}

const decisionSchema = z.object({ id: z.string().uuid(), decision: z.enum(['approve', 'reject']) }).strict();

/**
 * POST /api/approvals/decide: an admin approves or rejects a member's change. Approving sends the exact request
 * once, with the team account's authorization; either way the member's conversation is told the result.
 */
export function decideApprovalAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, decisionSchema, 'Choose approve or reject.');
    if ('response' in body) {
      return body.response;
    }
    const { id, decision } = body.data;
    if (decision === 'reject') {
      const rejected = await rejectApproval(env.DB, id, session.user.id);
      if (!rejected) {
        return Response.json({ error: 'This request was already decided.' }, { status: 409 });
      }
      await tellWorkspace(request, env, { ...rejected, approvalId: id });
      return Response.json({ status: 'rejected' });
    }
    const claimed = await claimApproval(env.DB, id, session.user.id);
    if (!claimed) {
      return Response.json(
        {
          error: 'This request can’t be approved now: it was decided already, it expired, or its sender left the team.',
        },
        { status: 409 },
      );
    }
    const outcome = await send(env, claimed.connectionId, claimed.request);
    const result = cloudflareExecutionStatusForOutcome(outcome);
    const safe = safeCloudflareExecutionOutcome(outcome);
    await finishApproval(env.DB, id, result, safe);
    await tellWorkspace(request, env, {
      requestedBy: claimed.requestedBy,
      connectionId: claimed.connectionId,
      agentName: claimed.agentName,
      approvalId: id,
    });
    return Response.json({ status: 'done', result, outcome: safe });
  });
}

/** Sends `request` once to the account `connectionId` is, provided it is still connected and still that account. */
async function send(env: Env, connectionId: string, request: CloudflareApiRequest): Promise<CloudflareApiOutcome> {
  const failure = (content: string): CloudflareApiOutcome => ({
    status: 'failure',
    content,
    requestId: null,
    httpStatus: null,
    truncated: false,
  });
  const connection = await findActiveCloudflareConnection(env.DB, connectionId);
  if (!connection?.credentialHandle) {
    return failure('The team’s Cloudflare account isn’t connected now, so nothing was sent.');
  }
  let checked: CloudflareApiRequest;
  try {
    checked = normalizeCloudflareApiRequest(request, connection.accountId);
  } catch {
    return failure('The request names another Cloudflare account, so nothing was sent.');
  }
  const client = accountClient(env, { ...connection, credentialHandle: connection.credentialHandle });
  try {
    return await client.send(checked, new AbortController().signal);
  } catch {
    // The authorization is read before anything is sent, and the client answers a send it lost track of itself.
    return failure('The team’s Cloudflare authorization couldn’t be read, so nothing was sent.');
  }
}

/**
 * Tells the requester's workspace that a request was decided, so their conversation shows the result. Best effort:
 * a workspace that can't be reached reads it the next time it asks.
 */
async function tellWorkspace(
  request: Request,
  env: Env,
  args: { requestedBy: string; connectionId: string; agentName: string; approvalId: string },
): Promise<void> {
  const runtime = await runtimeFor(request, env, args.requestedBy, args.connectionId);
  if ('refusal' in runtime) {
    return;
  }
  await fetch(new URL('/v1/approvals/settled', runtime.endpoint), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtime.token}`,
      origin: publicOrigin(request),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ agentName: args.agentName, approvalId: args.approvalId }),
  })
    .then((answer) => answer.body?.cancel())
    .catch(() => undefined);
}

const MAX_FILED_REQUEST_BYTES = 80 * 1024;

const fileSchema = z
  .object({
    agentName: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    requestJson: z.string().max(MAX_FILED_REQUEST_BYTES),
  })
  .strict();

/**
 * A member's workspace filing a change their agent asked for in the team's account. CloudChef checks it as it
 * would its own (another account's resources, CloudChef's own Workers and domains are refused) and files it for
 * the team's admins.
 */
export async function runtimeFileApprovalAction(args: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, fileSchema, {
    maxBytes: MAX_FILED_REQUEST_BYTES + 4 * 1024,
    label: 'Workspace runtime approval request',
    invalid: 'Invalid approval request.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity, connection } = authenticated;
  if (!connection.orgId || !(await findMembership(args.env.DB, connection.orgId, identity.userId))) {
    return json({ error: 'Only a team’s members file changes for its admins.' }, 403);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.requestJson);
  } catch {
    return json({ error: 'The request is not valid JSON.' }, 400);
  }
  const input = cloudflareApiRequestSchema.safeParse(parsed);
  if (!input.success) {
    return json({ error: 'The request is not a Cloudflare API request.' }, 400);
  }
  let request: CloudflareApiRequest;
  try {
    request = normalizeCloudflareApiRequest(input.data, connection.accountId);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'The request was refused.' }, 400);
  }
  if (cloudflareApiRequestIsRead(request)) {
    return json({ error: 'Only changes are filed for approval.' }, 400);
  }
  const client = accountClient(args.env, { ...connection, credentialHandle: authenticated.credentialHandle });
  const review = await reviewDomainChange(request, async (path) => {
    const outcome = await client
      .send({ method: 'GET', url: `https://api.cloudflare.com/client/v4${path}` }, new AbortController().signal)
      .catch(() => null);
    return outcome?.status === 'success' ? outcome.content : null;
  });
  if ('refusal' in review) {
    return json({ error: review.refusal }, 403);
  }
  const filed = await fileCloudflareChange(args.env.DB, {
    orgId: connection.orgId,
    connectionId: connection.id,
    userId: identity.userId,
    agentName: body.agentName,
    toolCallId: body.toolCallId,
    request,
    requestSha256: await sha256Hex(JSON.stringify(request)),
    warning: review.warning ?? null,
    expiresAt: Date.now() + TEAM_APPROVAL_TTL_MS,
  });
  return json({ approvalId: filed.id, expiresAt: filed.expiresAt, request, warning: review.warning ?? null }, 201);
}

const outcomeRequestSchema = z.object({ approvalId: z.string().uuid() }).strict();

/** A workspace reading back what became of a change it filed. */
export async function runtimeApprovalOutcomeAction(args: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(args.env, args.request, outcomeRequestSchema, {
    maxBytes: 1024,
    label: 'Workspace runtime approval outcome',
    invalid: 'Invalid approval outcome request.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const found = await approvalOutcomeFor(args.env.DB, {
    id: authenticated.body.approvalId,
    userId: authenticated.identity.userId,
    connectionId: authenticated.connection.id,
  });
  return found ? json(found, 200) : json({ error: 'Not found.' }, 404);
}
