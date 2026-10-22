import { z } from 'zod';
import { readJsonRequest } from '~/lib/.server/request-guards';
import {
  readAiGatewayContentLogging,
  setAiGatewayContentLogging,
} from '~/lib/cloudflare/data/ai-gateway-logging.server';
import { signedIn } from './signed-in';

/** Whether the signed-in person's model requests are logged with their content in the account's AI Gateway. */
export function aiGatewayLoggingAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) =>
    preferenceResponse(await readAiGatewayContentLogging(env.DB, session.user.id)),
  );
}

const updateSchema = z.strictObject({ contentLogging: z.boolean() });

/**
 * Turns the signed-in person's AI Gateway content logging on or off. Their workspace asks before each
 * model request, so the change applies from their next request, on every device and in every account.
 */
export function updateAiGatewayLoggingAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, updateSchema, 'Choose whether to log model requests.');
    if ('response' in body) {
      return body.response;
    }
    await setAiGatewayContentLogging(env.DB, session.user.id, body.data.contentLogging);
    return preferenceResponse(await readAiGatewayContentLogging(env.DB, session.user.id));
  });
}

function preferenceResponse(contentLogging: boolean): Response {
  return Response.json({ contentLogging }, { headers: { 'Cache-Control': 'private, no-store' } });
}
