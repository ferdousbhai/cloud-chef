import { z } from 'zod';
import { getAuthSession } from '~/lib/.server/auth';
import { hasSameOrigin, readJsonRequest } from '~/lib/.server/request-guards';
import {
  readAiGatewayContentLogging,
  setAiGatewayContentLogging,
} from '~/lib/cloudflare/data/ai-gateway-logging.server';

/** Whether the signed-in person's model requests are logged with their content in the account's AI Gateway. */
export async function aiGatewayLoggingAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Sign in first.' }, { status: 401 });
  }
  return preferenceResponse(await readAiGatewayContentLogging(env.DB, session.user.id));
}

const updateSchema = z.strictObject({ contentLogging: z.boolean() });

/**
 * Turns the signed-in person's AI Gateway content logging on or off. Their workspace asks before each
 * model request, so the change applies from their next request, on every device and in every account.
 */
export async function updateAiGatewayLoggingAction({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Sign in first.' }, { status: 401 });
  }
  const body = await readJsonRequest(request, updateSchema, 'Choose whether to log model requests.');
  if ('response' in body) {
    return body.response;
  }
  await setAiGatewayContentLogging(env.DB, session.user.id, body.data.contentLogging);
  return preferenceResponse(await readAiGatewayContentLogging(env.DB, session.user.id));
}

function preferenceResponse(contentLogging: boolean): Response {
  return Response.json({ contentLogging }, { headers: { 'Cache-Control': 'private, no-store' } });
}
