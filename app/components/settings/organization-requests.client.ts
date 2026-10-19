import { z } from 'zod';

const errorSchema = z.looseObject({ error: z.string().optional().catch(undefined) });

/** A 204: no body, which `postJson` reads as null. */
export const noContentSchema = z.null();

/** Posts to one of CloudChef's organization routes and parses its answer with `schema`. */
export async function postJson<T>(
  path: string,
  body: Record<string, string | number | boolean | string[]>,
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

async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new Error((parsed.success ? parsed.data.error : undefined) ?? 'Something went wrong. Try again.');
  }
  return schema.parse(payload);
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
