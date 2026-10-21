import { z } from 'zod';

const errorSchema = z.looseObject({
  error: z.string().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
});

/** A 204: no body, which `postJson` reads as null. */
export const noContentSchema = z.null();

/** Posts to one of CloudChef's organization routes and parses its answer with `schema`. */
export async function postJson<T>(
  path: string,
  body: Record<string, string | number | boolean | null | string[]>,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseResponse(response, schema);
}

/** Reads one of CloudChef's organization routes and parses its answer with `schema`. */
export async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return parseResponse(await fetch(path, { credentials: 'same-origin' }), schema);
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

/** What a person sees when an answer is not the shape the page expects: never the parser's own report. */
export const UNEXPECTED_ANSWER_MESSAGE = 'CloudChef answered unexpectedly. Reload the page and try again.';

async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new RequestError(
      (parsed.success ? parsed.data.error : undefined) ?? 'Something went wrong. Try again.',
      response.status,
      (parsed.success ? parsed.data.code : undefined) ?? null,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.warn(`Unexpected answer from ${response.url || 'CloudChef'}`);
    throw new RequestError(UNEXPECTED_ANSWER_MESSAGE, response.status);
  }
  return parsed.data;
}

export function messageOf(error: Error | null | undefined, fallback: string): string {
  return error?.message ?? fallback;
}

/** Runs one admin action, then refreshes, or shows why it failed. */
export async function run(
  action: () => Promise<void>,
  then: () => void | Promise<void>,
  onError: (message: string | null) => void,
): Promise<void> {
  onError(null);
  try {
    await action();
    await then();
  } catch (failure) {
    onError(messageOf(failure instanceof Error ? failure : null, 'That did not work. Try again.'));
  }
}
