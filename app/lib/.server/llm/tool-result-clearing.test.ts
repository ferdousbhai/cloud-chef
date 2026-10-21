import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateTextTokens } from './context-compaction';
import {
  clearedToolResultText,
  clearOldToolResults,
  RECENT_TOOL_RESULTS_KEPT,
  toolResultClearingTriggerTokens,
} from './tool-result-clearing';

describe('clearing old tool output', () => {
  it('shrinks a long build transcript to a fraction of its size and keeps every call', () => {
    const transcript = longBuildTranscript();
    const before = estimateTextTokens(JSON.stringify(sentToModel(transcript)));

    const { messages, savedTokens } = clearOldToolResults(transcript);
    const after = estimateTextTokens(JSON.stringify(sentToModel(messages)));

    // 60 tool calls over three requests, the shape of a real member session (92k-125k tokens a call).
    expect(before).toBeGreaterThan(100_000);
    expect(after).toBeLessThan(before * 0.25);
    expect(before - after).toBeGreaterThanOrEqual(savedTokens - 100);
    expect(messages).toHaveLength(transcript.length);
    expect(messages.map((message) => message.role)).toEqual(transcript.map((message) => message.role));
  });

  it('keeps the most recent results verbatim and leaves the input untouched', () => {
    const transcript = longBuildTranscript();
    const original = JSON.stringify(transcript);

    const { messages } = clearOldToolResults(transcript);

    const results = messages.filter((message) => message.role === 'toolResult');
    const recent = results.slice(-RECENT_TOOL_RESULTS_KEPT);
    expect(recent.every((message) => transcript.includes(message))).toBe(true);
    expect(results.at(0)).toMatchObject({ content: [{ type: 'text', text: clearedToolResultText('read') }] });
    expect(JSON.stringify(transcript)).toBe(original);
  });

  it('leaves short results alone, since their note would save nothing', () => {
    const transcript = Array.from({ length: 20 }, (_, index) => toolResult(`call-${index}`, 'ls', 'src/\nindex.html'));

    expect(clearOldToolResults(transcript).savedTokens).toBe(0);
  });

  it('is stable: clearing again changes nothing, so the cached prefix holds', () => {
    const once = clearOldToolResults(longBuildTranscript()).messages;
    const twice = clearOldToolResults(once);

    expect(twice.savedTokens).toBe(0);
    expect(JSON.stringify(twice.messages)).toBe(JSON.stringify(once));
  });

  it('starts at 64k tokens, or half the input budget of a smaller model', () => {
    expect(toolResultClearingTriggerTokens(900_000)).toBe(64_000);
    expect(toolResultClearingTriggerTokens(100_000)).toBe(50_000);
  });
});

/** What a provider receives: the conversation, without Pi's session-only `details`. */
function sentToModel(messages: AgentMessage[]) {
  return messages.map((message) =>
    message.role === 'toolResult'
      ? { role: message.role, toolName: message.toolName, content: message.content }
      : message,
  );
}

/** Three requests: explore and build, then two follow-ups, each reading files, editing, and running commands. */
function longBuildTranscript(): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const [turn, request] of ['Build a retreat booking site', 'Add a sign-up text', 'Fix the header'].entries()) {
    messages.push({ role: 'user', content: request, timestamp: turn });
    for (let step = 0; step < 20; step += 1) {
      const id = `call-${turn}-${step}`;
      const toolName = step % 4 === 3 ? 'exec' : step % 4 === 2 ? 'edit' : 'read';
      const output =
        toolName === 'read' ? 'x'.repeat(10_000) : toolName === 'exec' ? 'y'.repeat(8_000) : 'diff '.repeat(120);
      messages.push(assistantToolCall(id, toolName), toolResult(id, toolName, output));
    }
    messages.push(assistantText('Done.'));
  }
  return messages;
}

function toolResult(toolCallId: string, toolName: string, text: string): AgentMessage {
  return { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError: false, timestamp: 1 };
}

function assistantToolCall(id: string, name: string): AgentMessage {
  return assistant([{ type: 'toolCall', id, name, arguments: { path: '/home/project/src/application.ts' } }]);
}

function assistantText(text: string): AgentMessage {
  return assistant([{ type: 'text', text }]);
}

function assistant(content: Extract<AgentMessage, { role: 'assistant' }>['content']): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'cloudflare-workers-ai',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 1,
  };
}
