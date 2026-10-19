import type { z } from 'zod';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';

/** Checks shared by the account handlers: sign-in (Cloudflare, Google, email) and organizations. */

/** Small JSON bodies: an email, a name, a token. */
const MAX_REQUEST_BYTES = 4_096;

export function hasSameOrigin(request: Request): boolean {
  return request.headers.get('origin') === new URL(request.url).origin;
}

/** A path on this origin to return to after signing in; anything else returns to the builder. */
export function safeReturnTo(callbackURL: string | undefined, origin: string): string {
  if (!callbackURL) {
    return '/';
  }
  const callback = new URL(callbackURL, origin);
  if (callback.origin !== origin || callback.pathname.startsWith('//')) {
    return '/';
  }
  const returnTo = `${callback.pathname}${callback.search}${callback.hash}`;
  return returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [candidate, ...value] = part.trim().split('=');
    if (candidate !== name) {
      continue;
    }
    try {
      return decodeURIComponent(value.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

/** The request body checked against `schema`, or the response that refuses it. */
export async function readJsonRequest<T>(
  request: Request,
  schema: z.ZodType<T>,
  invalidMessage: string,
): Promise<{ data: T } | { response: Response }> {
  try {
    const parsed = schema.safeParse(await readJsonBodyWithLimit(request, MAX_REQUEST_BYTES, 'Request'));
    return parsed.success
      ? { data: parsed.data }
      : { response: Response.json({ error: invalidMessage }, { status: 400 }) };
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return { response: Response.json({ error: error.message }, { status: 413 }) };
    }
    if (error instanceof InvalidJsonBodyError) {
      return { response: Response.json({ error: 'Invalid request.' }, { status: 400 }) };
    }
    throw error;
  }
}
