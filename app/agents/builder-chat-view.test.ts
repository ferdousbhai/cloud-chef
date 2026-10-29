import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@earendil-works/chord';
import type { AssistantMessage, ToolResultMessage, Usage } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type EntryDraft,
  type EntryRecord,
  type LiveState,
} from '@earendil-works/pi-durable';
import { CHAT_ENTRY, STOPPED_TOOL_TEXT, chatMessages, liveToolProgress } from './builder-chat-view';

const USAGE: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Entries as pi-durable stores them, appended to a conversation in memory. */
async function stored(drafts: readonly EntryDraft[]): Promise<EntryRecord[]> {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const root = await harness.root(BACKGROUND_CONTEXT);
  const entries = await root.commit(async (tx) => {
    const appended: EntryRecord[] = [];
    for (const draft of drafts) {
      appended.push(await tx.appendEntry(root.id, draft));
    }
    return appended;
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  return entries;
}

function entry(draft: EntryDraft): EntryDraft {
  return draft;
}

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop') {
  const message: AssistantMessage = {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'cloudflare-ai-gateway',
    model: 'claude-opus-5-5',
    content,
    usage: USAGE,
    stopReason,
    timestamp: 1,
  };
  return entry({ kind: 'pi.assistant', model: [message] });
}

function userEntry(text: string) {
  return entry({
    kind: CHAT_ENTRY.user,
    data: { text },
    model: [
      {
        role: 'user',
        content: `<cloudchef_ephemeral_context>files</cloudchef_ephemeral_context>\n\n${text}`,
        timestamp: 1,
      },
    ],
  });
}

function toolResult(toolCallId: string, details: JsonValue | undefined, text = JSON.stringify(details)) {
  const result: ToolResultMessage = {
    role: 'toolResult',
    toolCallId,
    toolName: 'exec',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1,
  };
  if (details !== undefined) {
    result.details = details;
  }
  return entry({ kind: 'pi.tool-result', model: [result], data: { diagnostics: [] } });
}

describe('the chat derived from the transcript', () => {
  it("shows the person's text without the workspace context the model saw, and the run's work after it", async () => {
    const entries = await stored([
      entry({ kind: 'pi.system', model: [{ role: 'system', content: '', timestamp: 1 }] }),
      userEntry('Build a todo app'),
      assistant(
        [
          { type: 'thinking', thinking: 'Read the app first.', thinkingSignature: 'sig' },
          { type: 'thinking', thinking: '', thinkingSignature: 'opaque', redacted: true },
          { type: 'text', text: 'Reading.' },
          { type: 'toolCall', id: 'call-1', name: 'exec', arguments: { command: 'ls' } },
        ],
        'toolUse',
      ),
      toolResult('call-1', { command: 'ls', exitCode: 0, stdout: 'src' }),
      assistant([{ type: 'text', text: 'Done.' }]),
    ]);
    const user = entries[1]!;
    const messages = chatMessages(entries, undefined);

    expect(messages).toEqual([
      { id: String(user.id), role: 'user', parts: [{ type: 'text', text: 'Build a todo app' }] },
      {
        id: `${user.id}-a`,
        role: 'assistant',
        parts: [
          // Redacted thinking holds nothing to read: the chat never shows it.
          { type: 'reasoning', text: 'Read the app first.', state: 'done' },
          { type: 'text', text: 'Reading.', state: 'done' },
          {
            type: 'dynamic-tool',
            toolName: 'exec',
            toolCallId: 'call-1',
            input: { command: 'ls' },
            state: 'output-available',
            output: { command: 'ls', exitCode: 0, stdout: 'src' },
          },
          { type: 'text', text: 'Done.', state: 'done' },
        ],
      },
    ]);
  });

  it('shows what is streaming and which calls run, and a call that never got a result as stopped', async () => {
    const live: LiveState = {
      tools: [{ callId: 'call-2', name: 'exec', status: 'running', details: { stdout: 'installing' } }],
      generation: {
        attempt: 1,
        message: {
          role: 'assistant',
          api: 'anthropic-messages',
          provider: 'cloudflare-ai-gateway',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: 'Still' }],
          usage: USAGE,
          stopReason: 'stop',
          timestamp: 1,
        },
      },
    };
    const messages = chatMessages(
      await stored([
        userEntry('Fix it'),
        assistant([{ type: 'toolCall', id: 'call-old', name: 'exec', arguments: {} }], 'aborted'),
        assistant([{ type: 'toolCall', id: 'call-2', name: 'exec', arguments: { command: 'pnpm i' } }], 'toolUse'),
      ]),
      live,
    );

    expect(messages[1]?.parts).toEqual([
      expect.objectContaining({ toolCallId: 'call-old', state: 'output-error', errorText: STOPPED_TOOL_TEXT }),
      expect.objectContaining({ toolCallId: 'call-2', state: 'input-available' }),
      { type: 'text', text: 'Still', state: 'streaming' },
    ]);
    expect(liveToolProgress(live)).toEqual([
      { toolCallId: 'call-2', toolName: 'exec', result: { stdout: 'installing' } },
    ]);
  });

  it("shows a call the harness answered (interrupted by a restart) with pi's words, and a newer output in its place", async () => {
    const messages = chatMessages(
      await stored([
        userEntry('Deploy'),
        assistant(
          [
            { type: 'toolCall', id: 'call-1', name: 'exec', arguments: { command: 'cf deploy' } },
            { type: 'toolCall', id: 'call-2', name: 'exec', arguments: { command: 'git push' } },
          ],
          'toolUse',
        ),
        toolResult('call-1', undefined, 'The call was interrupted before it finished.'),
        toolResult('call-2', { ok: true, summary: 'Pushed' }),
        entry({ kind: CHAT_ENTRY.toolOutput, data: { toolCallId: 'call-2', output: { ok: true, summary: 'Live' } } }),
      ]),
      undefined,
    );

    expect(messages[1]?.parts).toEqual([
      expect.objectContaining({ state: 'output-error', errorText: 'The call was interrupted before it finished.' }),
      expect.objectContaining({ state: 'output-available', output: { ok: true, summary: 'Live' } }),
    ]);
  });

  it('shows a handoff where the conversation went on from it, and not the request sent again after it', async () => {
    const messages = chatMessages(
      await stored([
        userEntry('Keep going'),
        assistant([{ type: 'text', text: 'Working.' }], 'stop'),
        entry({ kind: CHAT_ENTRY.handoff, data: { note: '## Done\n- the form' } }),
        entry({ kind: 'pi.reset', head: 'self', model: [{ role: 'user', content: 'opening', timestamp: 1 }] }),
        entry({ kind: CHAT_ENTRY.continued, model: [{ role: 'user', content: 'Keep going', timestamp: 1 }] }),
        assistant([{ type: 'text', text: 'Carrying on.' }]),
      ]),
      undefined,
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]?.parts).toEqual([
      { type: 'text', text: 'Working.', state: 'done' },
      { type: 'data-handoff', data: { note: '## Done\n- the form' } },
      { type: 'text', text: 'Carrying on.', state: 'done' },
    ]);
  });

  it('shows the messages of a chat from before pi-durable as they were, without redacted thinking', async () => {
    const messages = chatMessages(
      await stored([
        entry({
          kind: CHAT_ENTRY.legacy,
          data: { message: { id: 'old-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] } },
        }),
        entry({
          kind: CHAT_ENTRY.legacy,
          data: {
            message: {
              id: 'old-2',
              role: 'assistant',
              parts: [
                { type: 'reasoning', text: '', providerMetadata: { anthropic: { redactedData: 'opaque' } } },
                { type: 'text', text: 'Hi' },
              ],
            },
          },
        }),
        userEntry('Next'),
      ]),
      undefined,
    );

    expect(messages.map((message) => message.id)).toEqual(['old-1', 'old-2', expect.any(String)]);
    expect(messages[1]?.parts).toEqual([{ type: 'text', text: 'Hi' }]);
  });
});
