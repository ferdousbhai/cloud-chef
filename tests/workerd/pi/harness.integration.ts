import { abortAllDurableObjects, runDurableObjectAlarm } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getToolInvocation, type CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { HANDOFF_PART_TYPE } from 'cloudchef-agent/handoff';
import type { BuilderPiTestObject } from './worker';

/**
 * The builder's pi-durable setup on real Durable Object SQLite (`worker.ts`): a run that calls a tool, a tool that
 * waits for an approval, a restart in the middle of a call, and a handoff that carries on.
 */

declare global {
  namespace Cloudflare {
    interface Env {
      /** Bound only in this test's Worker (`wrangler.jsonc`). */
      BUILDER?: DurableObjectNamespace<BuilderPiTestObject>;
    }
  }
}

function builderNamespace(): DurableObjectNamespace<BuilderPiTestObject> {
  if (!env.BUILDER) {
    throw new Error('The test Worker binds BUILDER.');
  }
  return env.BUILDER;
}

const namespace = builderNamespace();

async function chat(builder: DurableObjectStub<BuilderPiTestObject>): Promise<CloudChefMessage[]> {
  return JSON.parse(await builder.messages());
}

async function eventually(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('The condition did not hold in time.');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the builder on pi-durable in a Durable Object', () => {
  it('runs a command that waits for an approval, and shows the run in the chat', async () => {
    const builder = namespace.get(namespace.idFromName('approval'));
    await builder.script([{ command: 'cf workers delete old', id: 'call-1' }, { text: 'Deleted the old worker.' }]);

    const operation = await builder.send('Delete the old worker');
    await eventually(() => builder.running());
    const waiting = (await chat(builder))[1]?.parts.map(getToolInvocation).find(Boolean);
    expect(waiting).toMatchObject({ toolCallId: 'call-1', state: 'input-available' });

    expect(await builder.approve()).toBe(true);
    expect(await builder.settle(operation)).toBe('done');
    const parts = (await chat(builder))[1]?.parts ?? [];
    expect(parts.map(getToolInvocation).find(Boolean)).toMatchObject({
      toolCallId: 'call-1',
      state: 'output-available',
      output: { command: 'cf workers delete old', exitCode: 0 },
    });
    expect(parts.at(-1)).toMatchObject({ type: 'text', text: 'Deleted the old worker.' });
  });

  it('after a reset cut a command off, reopens on what it stored, reports it interrupted and goes on', async () => {
    const id = namespace.idFromName('restart');
    const before = namespace.get(id);
    await before.script([{ command: 'pnpm build', id: 'call-1' }]);
    const operation = await before.send('Build it');
    await eventually(() => before.running());

    // The object is reset in the middle of the call, as a crash or a deploy resets it; its storage stays.
    await abortAllDurableObjects();
    const builder = namespace.get(id);
    await builder.script([{ text: 'The build was cut off.' }]);
    // The harness's wake job is due: its alarm starts the object again, and pi resumes the run.
    await runDurableObjectAlarm(builder);

    expect(await builder.settle(operation)).toBe('done');
    const parts = (await chat(builder))[1]?.parts ?? [];
    expect(parts.map(getToolInvocation).find(Boolean)).toMatchObject({ toolCallId: 'call-1', state: 'output-error' });
    expect(parts.at(-1)).toMatchObject({ text: 'The build was cut off.' });
  });

  it('hands off near the limit and carries on from the note with the latest request', async () => {
    const builder = namespace.get(namespace.idFromName('handoff'));
    // A command long enough to put the context past the small window's handoff point.
    await builder.script([
      { command: `echo ${'x'.repeat(8_000)}`, id: 'call-1' },
      { text: '## Asked\nA todo form.' },
      { text: 'Carrying on with the form.' },
    ]);

    const operation = await builder.send('Build the todo form');
    await eventually(() => builder.running());
    await builder.approve();

    expect(await builder.settle(operation)).toBe('done');
    expect(await builder.modelRequests()).toBe(3);
    const messages = await chat(builder);
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    const parts = messages[1]?.parts ?? [];
    expect(parts.find((part) => part.type === HANDOFF_PART_TYPE)).toEqual({
      type: HANDOFF_PART_TYPE,
      data: { note: '## Asked\nA todo form.' },
    });
    expect(parts.at(-1)).toMatchObject({ text: 'Carrying on with the form.' });
  });
});
