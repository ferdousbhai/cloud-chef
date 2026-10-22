import { z } from 'zod';

const errorSchema = z.looseObject({
  error: z.string().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
});

/** A 204: no body, which `postJson` reads as null. */
export const noContentSchema = z.null();

/** What a person sees when an answer is not the shape the page expects: never the parser's own report. */
const UNEXPECTED_ANSWER_MESSAGE = 'CloudChef answered unexpectedly. Reload the page and try again.';

/**
 * Posts to one of CloudChef's routes and parses its answer with `schema`. `fallback`, when given, is
 * what a refusal that gives no reason, or an answer of the wrong shape, says instead of the generic words.
 */
export async function postJson<T>(
  path: string,
  body: Record<string, string | number | boolean | null | undefined | string[]>,
  schema: z.ZodType<T>,
  fallback?: string,
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseResponse(response, schema, fallback);
}

/** Reads one of CloudChef's routes and parses its answer with `schema`; `fallback` as for `postJson`. */
export async function getJson<T>(path: string, schema: z.ZodType<T>, fallback?: string): Promise<T> {
  return parseResponse(await fetch(path, { credentials: 'same-origin' }), schema, fallback);
}

/** A refusal from one of CloudChef's routes, with its HTTP status. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** What the route said the client can do something about, such as `sole_member`. */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

async function parseResponse<T>(response: Response, schema: z.ZodType<T>, fallback: string | undefined): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new RequestError(
      (parsed.success ? parsed.data.error : undefined) ?? fallback ?? 'Something went wrong. Try again.',
      response.status,
      (parsed.success ? parsed.data.code : undefined) ?? null,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.warn(`Unexpected answer from ${response.url || 'CloudChef'}`);
    throw new RequestError(fallback ?? UNEXPECTED_ANSWER_MESSAGE, response.status);
  }
  return parsed.data;
}

/** What a caught failure says, or `fallback` when it is not an Error. */
export function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
