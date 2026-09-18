import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { z } from 'zod';
import { UnauthorizedError } from './auth.server';
import { DataNotFoundError, SubchatLimitError } from './errors';
import { InvalidJsonBodyError, PayloadTooLargeError } from '~/lib/bounded-body';
import { isDurableObjectOverloadedError } from '~/lib/cloudflare/durable-object-rpc.server';

const logger = createScopedLogger('CloudflareData');

export const DURABLE_OBJECT_OVERLOADED_MESSAGE =
  'This project is handling too much at once. Wait a moment and try again.';

/** Enough of an unhandled failure to identify it, without putting a payload in a log. */
function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function internalErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof z.ZodError) {
    return Response.json({ error: 'Invalid request', issues: error.issues }, { status: 400 });
  }
  if (error instanceof UnauthorizedError) {
    return Response.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof DataNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof SubchatLimitError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof PayloadTooLargeError) {
    return Response.json({ error: error.message }, { status: 413 });
  }
  if (error instanceof InvalidJsonBodyError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (isDurableObjectOverloadedError(error)) {
    // An overloaded object is busy, not broken. Saying so beats the caller's generic
    // fallback, and refusing the retry left the caller stuck on a condition that clears
    // by itself.
    logger.error('Cloudflare data request rejected by an overloaded Durable Object');
    return Response.json({ error: DURABLE_OBJECT_OVERLOADED_MESSAGE, retryable: true }, { status: 503 });
  }
  logger.error('Unhandled Cloudflare data request failure', errorSummary(error));
  return Response.json({ error: fallback }, { status: 500 });
}

export function ensureDataBindings(env: Env): void {
  if (!env.DB) {
    throw new Error('Cloudflare D1 binding DB is not configured');
  }
}
