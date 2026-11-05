import { describe, expect, it } from 'vitest';
import { lookedUpField } from './resource-lookup';

const found = () => Response.json({ result: { name: 'my-db' } });
const refused = (status = 403, code = 7403) =>
  Response.json({ errors: [{ code, message: 'Not authorized' }] }, { status, headers: { 'cf-ray': 'abc123' } });

async function run(answers: Response[], field: 'name' | 'title' = 'name') {
  const waits: number[] = [];
  const notes: string[] = [];
  let sent = 0;
  const value = await lookedUpField(
    field,
    async () => answers[Math.min(sent++, answers.length - 1)]!.clone(),
    (line) => notes.push(line),
    async (ms) => {
      waits.push(ms);
    },
  );
  return { value, waits, notes, sent };
}

describe('lookedUpField', () => {
  it('answers at once when Cloudflare does', async () => {
    expect(await run([found()])).toEqual({ value: 'my-db', waits: [], notes: [], sent: 1 });
  });

  it('reads the field asked for', async () => {
    const answer = Response.json({ result: { title: 'my-kv' } });
    expect((await run([answer], 'title')).value).toBe('my-kv');
    expect((await run([answer], 'name')).value).toBeUndefined();
  });

  it.each([401, 403, 429, 500, 503])('waits out a %i and logs what Cloudflare said', async (status) => {
    const result = await run([refused(status), found()]);
    expect(result.value).toBe('my-db');
    expect(result.waits).toEqual([1_000]);
    expect(result.notes).toEqual([
      `Cloudflare answered ${status}, code 7403, Not authorized, cf-ray abc123; trying again in 1s`,
    ]);
  });

  it('gives up with nothing after about 15 seconds of refusals', async () => {
    const result = await run([refused()]);
    expect(result.value).toBeUndefined();
    expect(result.sent).toBe(5);
    expect(result.waits).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(result.notes.at(-1)).toBe('Cloudflare answered 403, code 7403, Not authorized, cf-ray abc123');
  });

  it('takes a 404 as the answer', async () => {
    const result = await run([refused(404, 7404), found()]);
    expect(result.value).toBeUndefined();
    expect(result.sent).toBe(1);
    expect(result.waits).toEqual([]);
  });

  it('never accepts a name from a failed answer', async () => {
    const result = await run([Response.json({ result: { name: 'my-db' } }, { status: 403 })]);
    expect(result.value).toBeUndefined();
  });

  it('gives up on an answer without the field, and says so', async () => {
    const result = await run([Response.json({ result: {} })]);
    expect(result.value).toBeUndefined();
    expect(result.sent).toBe(1);
    expect(result.notes).toEqual(['Cloudflare answered 200, without the field looked for']);
  });

  it('copes with an answer that is not JSON', async () => {
    const result = await run([new Response('Bad gateway', { status: 502 }), found()]);
    expect(result.value).toBe('my-db');
    expect(result.notes[0]).toBe('Cloudflare answered 502; trying again in 1s');
  });
});
