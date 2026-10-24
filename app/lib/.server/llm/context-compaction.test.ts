import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import {
  assembleCompactedContext,
  compactContext,
  compactPiContext,
  estimatePiContextTokens,
  MAX_HANDOFF_CHARACTERS,
} from './context-compaction';

const user = (id: string, text: string): CloudChefMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const assistant = (id: string, text: string): CloudChefMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
});
const oldHandoff = (id: string, text: string): CloudChefMessage => ({
  id,
  role: 'assistant',
  parts: [
    {
      type: 'dynamic-tool',
      toolName: 'new_context',
      toolCallId: id,
      state: 'output-available',
      input: { handoff: text },
      output: { success: true },
    },
  ],
});

function toolCall(): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'write1', name: 'write', arguments: { path: 'todo.ts' } }],
    api: 'openai-completions',
    provider: 'cloudflare-workers-ai',
    model: 'model',
    timestamp: 2,
    stopReason: 'toolUse',
    usage: {
      input: 100000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 101000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe('context rollover', () => {
  it('keeps a newly submitted request verbatim and never mutates stored history', () => {
    const messages = [
      user('u1', 'Build a todo app'),
      assistant('a1', 'Old work'.repeat(10000)),
      user('u2', 'Add due dates'),
    ];
    const original = structuredClone(messages);
    const checkpoint = compactContext({ messages });
    const active = assembleCompactedContext(messages, checkpoint);
    expect(active.messages).toHaveLength(2);
    expect(active.messages.at(-1)).toEqual(messages[2]);
    expect(checkpoint?.toMessageId).toBe('a1');
    expect(checkpoint?.summary).toContain('Build a todo app');
    expect(messages).toEqual(original);
  });

  it('retires a single large completed assistant turn without a summarizer', () => {
    const checkpoint = compactContext({ messages: [user('u', 'a to do app'), assistant('a', 'code'.repeat(200000))] });
    expect(checkpoint?.toMessageId).toBe('a');
    expect(checkpoint?.summary.length).toBeLessThanOrEqual(MAX_HANDOFF_CHARACTERS);
  });

  it('rolls over again without nesting recovery records, keeping an old handoff call as plain tool activity', () => {
    const messages = [user('u1', 'todo'), oldHandoff('a1', 'Database ready. Next: wire the form.')];
    const first = compactContext({ messages });
    expect(first?.summary).toContain('new_context');
    const second = compactContext({
      messages: [...messages, user('u2', 'also filter'), assistant('a2', 'work')],
      current: first,
    });
    expect(second?.summary.match(/Automatic context rollover recovery record/g)).toHaveLength(1);
    expect(second?.summary).toContain('also filter');
  });

  it('does not replay stale handoffs after a rewind changes the checkpoint anchors', () => {
    const current = { summary: 'stale secret decision', fromMessageId: 'gone', toMessageId: 'a1' };
    const messages = [user('u1', 'New branch'), assistant('a1', 'New work')];
    expect(assembleCompactedContext(messages, current).overlayApplied).toBe(false);
    expect(compactContext({ messages, current })?.summary).not.toContain('stale secret decision');
  });

  it('reads checkpoints saved by the previous release', () => {
    const messages = [user('u1', 'todo'), assistant('a1', 'work'), user('u2', 'continue')];
    const active = assembleCompactedContext(messages, {
      summary: 'Legacy checkpoint',
      fromMessageId: 'u1',
      toMessageId: 'a1',
    });
    expect(active.overlayApplied).toBe(true);
    expect(JSON.stringify(active.messages)).toContain('Legacy checkpoint');
  });

  it('preserves the unconsumed tool batch and drops stale usage counts in a fresh live window', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'todo', timestamp: 1 },
      toolCall(),
      {
        role: 'toolResult',
        toolCallId: 'write1',
        toolName: 'write',
        content: [{ type: 'text', text: 'Revision 42 saved' }],
        isError: false,
        timestamp: 3,
      },
    ];
    const original = structuredClone(messages);
    const next = compactPiContext({ messages });
    expect(next).toHaveLength(1);
    expect(JSON.stringify(next)).toContain('Revision 42 saved');
    expect(estimatePiContextTokens(next ?? [])).toBeLessThan(6000);
    expect(estimatePiContextTokens(messages)).toBeGreaterThan(100000);
    expect(messages).toEqual(original);
  });

  it('retains user steering through repeated live rollovers', () => {
    const originalInputs: AgentMessage[] = [
      { role: 'user', content: 'Build todo', timestamp: 1 },
      { role: 'user', content: 'Correction: store tasks only in the browser', timestamp: 2 },
    ];
    const first = compactPiContext({ messages: [...originalInputs, toolCall()] });
    const second = compactPiContext({
      messages: [...(first ?? []), toolCall()],
      previousInputs: originalInputs,
    });
    expect(JSON.stringify(second)).toContain('Correction: store tasks only in the browser');
  });

  it('bounds recovery records for oversized user inputs and tool batches', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'x'.repeat(200000), timestamp: 1 },
      toolCall(),
      ...Array.from({ length: 100 }, (_, index): AgentMessage => ({
        role: 'toolResult',
        toolCallId: `t${index}`,
        toolName: 'read',
        content: [{ type: 'text', text: 'output'.repeat(10000) }],
        isError: false,
        timestamp: 3,
      })),
    ];
    const next = compactPiContext({ messages });
    expect(JSON.stringify(next).length).toBeLessThan(25000);
    expect(JSON.stringify(next)).toContain('Truncated');
  });

  it('does not discard an initial prompt to hide a provider rejection', () => {
    expect(compactPiContext({ messages: [{ role: 'user', content: 'a to do app', timestamp: 1 }] })).toBeNull();
    expect(compactContext({ messages: [user('u', 'a to do app')] })).toBeNull();
  });

  it('honors cancellation before creating a checkpoint', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      compactContext({ messages: [user('u', 'todo'), assistant('a', 'work')], signal: controller.signal }),
    ).toThrow();
  });
});
