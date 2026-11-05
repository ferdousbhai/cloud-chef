import { z } from 'zod';

/**
 * Cloudflare sometimes refuses a token for a few seconds around when it was refreshed, while the token is good. The
 * lookup behind a deploy's D1 and KV checks is often that token's first use, so it waits this out. About 15 seconds in
 * all; the same token goes each time, since asking for a new one could start the same wait over.
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];
const MAX_MESSAGE_CHARACTERS = 200;

const answerSchema = z.looseObject({
  result: z.looseObject({ name: z.string().optional(), title: z.string().optional() }).nullish(),
  errors: z.array(z.looseObject({ code: z.number().optional(), message: z.string().optional() })).nullish(),
});

function parsedAnswer(text: string): z.infer<typeof answerSchema> | undefined {
  try {
    return answerSchema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

/** Refusals that can pass, and Cloudflare's own failures. A 404 is an answer: the resource isn't there. */
function worthRetrying(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

/** What Cloudflare said, for the build log: the one thing that tells these failures apart. */
function describedAnswer(response: Response, answer: z.infer<typeof answerSchema> | undefined): string {
  const error = answer?.errors?.[0];
  return [
    `Cloudflare answered ${response.status}`,
    ...(error?.code === undefined ? [] : [`code ${error.code}`]),
    ...(error?.message ? [error.message.slice(0, MAX_MESSAGE_CHARACTERS)] : []),
    ...(response.ok ? ['without the field looked for'] : []),
    ...(response.headers.has('cf-ray') ? [`cf-ray ${response.headers.get('cf-ray')}`] : []),
  ].join(', ');
}

/**
 * A resource's name or title from Cloudflare, or undefined if it couldn't be had. Callers refuse the deploy's request
 * then: nothing here may let an unchecked resource through.
 */
export async function lookedUpField(
  field: 'name' | 'title',
  send: () => Promise<Response>,
  note: (line: string) => void,
  wait: (ms: number) => Promise<void> = (ms) => scheduler.wait(ms),
): Promise<string | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await send();
    const answer = parsedAnswer(await response.text().catch(() => ''));
    const value = response.ok ? answer?.result?.[field] : undefined;
    if (value !== undefined) {
      return value;
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined || !worthRetrying(response.status)) {
      note(describedAnswer(response, answer));
      return undefined;
    }
    note(`${describedAnswer(response, answer)}; trying again in ${delay / 1000}s`);
    await wait(delay);
  }
}
