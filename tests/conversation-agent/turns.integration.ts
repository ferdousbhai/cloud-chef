import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import { getToolInvocation } from 'cloudchef-agent/ai-compat';
import type { CloudflareApiRequest } from 'cloudchef-agent/cloudflare-api';
import { HANDOFF_PART_TYPE } from 'cloudchef-agent/handoff';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { HANDOFF_REQUEST } from '~/lib/.server/llm/handoff';
import { AGENT_NAME, conversationAgentHarness, eventually, type ConversationAgentHarness } from './harness';

/**
 * A turn as the person sends it: the agent hands it to pi-durable, which runs the model (scripted here) and the
 * builder's tools against the project's workspace, and the chat follows from the transcript.
 */

type ExecuteCommand = BuilderWorkspaceApi['executeCommand'];

/** A workspace whose commands run as `executeCommand` says; other tools are not called. */
function commandWorkspace(executeCommand: ExecuteCommand): Partial<BuilderWorkspaceApi> {
  return {
    executeToolOnce: async (_toolCallId, _toolName, _input, run) => run(),
    executeCommand,
  };
}

function usageOf(input: number): AssistantMessage['usage'] {
  return {
    input,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function runCommand(command: string, id: string, input = 100): AssistantMessage {
  return {
    ...fauxAssistantMessage(fauxToolCall('exec', { command }, { id }), { stopReason: 'toolUse' }),
    usage: usageOf(input),
  };
}

function answer(text: string): AssistantMessage {
  return { ...fauxAssistantMessage(fauxText(text)), usage: usageOf(100) };
}

/** What the model was sent, by request: the text of each message. */
function sentTexts(context: TranscriptContext): string[] {
  return context.messages.flatMap((message) => {
    if (message.role === 'user') {
      return [
        Array.isArray(message.content)
          ? message.content.map((block) => ('text' in block ? block.text : '')).join('')
          : message.content,
      ];
    }
    if (message.role === 'toolResult') {
      return [message.content.map((block) => ('text' in block ? block.text : '')).join('')];
    }
    if (message.role === 'assistant') {
      return [
        message.content
          .map((block) => (block.type === 'text' ? block.text : block.type === 'toolCall' ? `call ${block.id}` : ''))
          .join(''),
      ];
    }
    return [];
  });
}

async function send(harness: ConversationAgentHarness, text: string) {
  return harness.agent.sendMessage({
    text,
    turnContext: { version: 1, content: 'Open file: src/app.ts' },
    transcript: { agentName: AGENT_NAME, subchatIndex: 0 },
    modelId: CLOUDFLARE_WORKERS_AI_MODEL,
  });
}

async function turnEnded(harness: ConversationAgentHarness) {
  await eventually(() => harness.agent.state.activeTurn === null, 10_000);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal('scheduler', { wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) });
  // The control plane, reached for usage reports and team approvals, answers nothing a turn needs.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('unavailable', { status: 503 }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a builder turn on pi-durable', () => {
  it('runs a command the model asks for and shows the run in the chat, the person seeing only what they typed', async () => {
    const faux = fauxProvider();
    let sent: string[] = [];
    faux.setResponses([
      runCommand('ls', 'call-1'),
      (context) => {
        sent = sentTexts(context);
        return { ...fauxAssistantMessage(fauxText('The app has a src folder.')), usage: usageOf(100) };
      },
    ]);
    const harness = await conversationAgentHarness({
      faux,
      workspace: commandWorkspace(async () => ({ exitCode: 0, stdout: 'src', stderr: '' })),
    });

    await expect(send(harness, 'What is in the project?')).resolves.toEqual({ accepted: true });
    await turnEnded(harness);

    expect(harness.agent.state.lastCompletedTurn).toMatchObject({ status: 'completed' });
    // The model saw the turn's workspace context with the message; the chat shows only the text.
    expect(sent[0]).toContain('Open file: src/app.ts');
    expect(sent[0]).toContain('What is in the project?');
    const messages = await harness.messages();
    expect(messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'What is in the project?' }] });
    const parts = messages[1]?.parts ?? [];
    expect(parts.map(getToolInvocation).find(Boolean)).toMatchObject({
      toolName: 'exec',
      toolCallId: 'call-1',
      state: 'output-available',
      output: expect.objectContaining({ command: 'ls', exitCode: 0, stdout: 'src' }),
    });
    expect(parts.at(-1)).toEqual({ type: 'text', text: 'The app has a src folder.', state: 'done' });
  });

  it('keeps a command running while a Cloudflare change it asked for waits for the person, then goes on', async () => {
    const faux = fauxProvider();
    faux.setResponses([runCommand('cf workers delete old', 'call-cf'), answer('Deleted.')]);
    const asked = deferred<string>();
    const decided = deferred<void>();
    const change: CloudflareApiRequest = {
      method: 'DELETE',
      url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old',
    };
    let harness: ConversationAgentHarness | undefined;
    harness = await conversationAgentHarness({
      faux,
      cloudflareIdentity: true,
      workspace: commandWorkspace(async () => {
        // The runtime's Cloudflare API proxy hands `cf`'s change to the agent under this call's id.
        const answer = await harness!.agent.proposeWorkspaceCloudflareChange({
          toolCallId: 'call-cf',
          request: change,
        });
        asked.resolve(answer.kind === 'waiting' ? answer.executionId : '');
        await decided.promise;
        return { exitCode: 0, stdout: 'deleted', stderr: '' };
      }),
    });
    Reflect.set(harness.agent, 'createCloudflareApiClient', () => ({
      send: async () => ({ status: 'success', content: '{}', requestId: 'ray', httpStatus: 200, truncated: false }),
    }));

    await send(harness, 'Delete the old worker');
    const executionId = await asked.promise;
    // The chat shows the waiting change in the command's place, with Approve and Reject.
    expect(harness.agent.state.cloudflareExecutions).toEqual([
      expect.objectContaining({ executionId, toolCallId: 'call-cf', status: 'awaiting_approval' }),
    ]);
    expect(harness.agent.state.activeTurn).toMatchObject({ status: 'accepted' });

    await harness.agent.workspaceCloudflareChangeOutcome({ toolCallId: 'call-cf', executionId });
    await expect(harness.agent.approveCloudflareExecution({ executionId })).resolves.toMatchObject({
      execution: { status: 'succeeded' },
    });
    decided.resolve();
    await turnEnded(harness);

    expect(harness.agent.state.lastCompletedTurn).toMatchObject({ status: 'completed' });
    expect((await harness.messages())[1]?.parts.at(-1)).toMatchObject({ text: 'Deleted.' });
  });

  it('leaves a change its command stopped waiting for in the chat, and tells the model the decision next turn', async () => {
    const faux = fauxProvider();
    let sent: string[] = [];
    faux.setResponses([
      runCommand('cf workers delete old', 'call-cf'),
      answer('It waits for you in the chat.'),
      (context) => {
        sent = sentTexts(context);
        return answer('The old worker is gone.');
      },
    ]);
    let executionId = '';
    let harness: ConversationAgentHarness | undefined;
    harness = await conversationAgentHarness({
      faux,
      cloudflareIdentity: true,
      workspace: commandWorkspace(async () => {
        const answer = await harness!.agent.proposeWorkspaceCloudflareChange({
          toolCallId: 'call-cf',
          request: {
            method: 'DELETE',
            url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old',
          },
        });
        executionId = answer.kind === 'waiting' ? answer.executionId : '';
        // The command's wait ran out before the person decided: it ends, and the change stays in the chat.
        return { exitCode: 1, stdout: '', stderr: 'still waiting for approval' };
      }),
    });
    Reflect.set(harness.agent, 'createCloudflareApiClient', () => ({
      send: async () => ({ status: 'success', content: '{}', requestId: 'ray', httpStatus: 200, truncated: false }),
    }));

    await send(harness, 'Delete the old worker');
    await turnEnded(harness);
    const waiting = (await harness.messages())[1]?.parts.map(getToolInvocation).find(Boolean);
    expect(JSON.stringify(waiting?.output)).toContain('cloudflare_change_waiting_in_chat');

    await expect(harness.agent.approveCloudflareExecution({ executionId })).resolves.toMatchObject({
      execution: { status: 'succeeded' },
    });
    const decided = (await harness.messages())[1]?.parts.map(getToolInvocation).find(Boolean);
    expect(JSON.stringify(decided?.output)).not.toContain('cloudflare_change_waiting_in_chat');

    await send(harness, 'Is it done?');
    await turnEnded(harness);
    expect(sent.some((text) => text.includes('left waiting in the chat was decided'))).toBe(true);
  });

  it('takes a message sent while the run works into it after the running command', async () => {
    const faux = fauxProvider();
    let sent: string[] = [];
    faux.setResponses([
      runCommand('pnpm test', 'call-1'),
      (context) => {
        sent = sentTexts(context);
        return { ...fauxAssistantMessage(fauxText('Using pnpm.')), usage: usageOf(100) };
      },
    ]);
    const running = deferred<void>();
    const finish = deferred<void>();
    const harness = await conversationAgentHarness({
      faux,
      workspace: commandWorkspace(async () => {
        running.resolve();
        await finish.promise;
        return { exitCode: 0, stdout: 'passed', stderr: '' };
      }),
    });

    await send(harness, 'Run the tests');
    await running.promise;
    await expect(send(harness, 'Use pnpm, not npm')).resolves.toEqual({ accepted: true });
    finish.resolve();
    await turnEnded(harness);

    expect(sent.some((text) => text.includes('Use pnpm, not npm'))).toBe(true);
    const messages = await harness.messages();
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[2]?.parts).toEqual([{ type: 'text', text: 'Use pnpm, not npm' }]);
  });

  it('stops the run on Stop: the running command is aborted and the chat says it stopped', async () => {
    const faux = fauxProvider();
    faux.setResponses([runCommand('pnpm dev', 'call-1'), answer('never sent')]);
    const running = deferred<void>();
    const harness = await conversationAgentHarness({
      faux,
      workspace: commandWorkspace(
        async ({ abortSignal }) =>
          new Promise((_resolve, reject) => {
            running.resolve();
            abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
          }),
      ),
    });

    await send(harness, 'Start the dev server');
    await running.promise;
    await expect(harness.agent.cancelActiveTurn()).resolves.toEqual({ stopped: true });

    expect(harness.agent.state.activeTurn).toBeNull();
    expect(harness.agent.state.lastCompletedTurn).toMatchObject({ status: 'aborted' });
    await eventually(() => faux.getPendingResponseCount() === 1);
    const call = (await harness.messages())[1]?.parts.map(getToolInvocation).find(Boolean);
    expect(call).toMatchObject({ toolCallId: 'call-1', state: 'output-error' });
  });

  it("reports each response's tokens for the organization's per-member usage", async () => {
    const faux = fauxProvider();
    faux.setResponses([runCommand('ls', 'call-1', 1_000), answer('Done.')]);
    const reported: unknown[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/runtime-usage')) {
        reported.push(JSON.parse(String(init?.body)));
        return Response.json({});
      }
      return new Response('unavailable', { status: 503 });
    });
    const harness = await conversationAgentHarness({
      faux,
      cloudflareIdentity: true,
      workspace: commandWorkspace(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });

    await send(harness, 'List the files');
    await turnEnded(harness);

    // One report per response, with the tokens the provider counted.
    await eventually(() => reported.length === 2);
    expect(reported).toEqual([
      { inputTokens: expect.any(Number), outputTokens: expect.any(Number), cachedTokens: expect.any(Number) },
      { inputTokens: expect.any(Number), outputTokens: expect.any(Number), cachedTokens: expect.any(Number) },
    ]);
    expect(reported.every((usage) => z.object({ inputTokens: z.number().positive() }).safeParse(usage).success)).toBe(
      true,
    );
  });

  it('near the limit, writes a handoff note and carries on from it with the latest request, without the person', async () => {
    // A small window: the system prompt and the first round of work, as the provider counts them, already pass the
    // handoff point, which a turn's start, with no work yet, does not hand off at.
    const faux = fauxProvider({ models: [{ id: 'small-window', contextWindow: 2_500 }] });
    const requests: string[][] = [];
    const record =
      (step: AssistantMessage): FauxResponseStep =>
      (context) => {
        requests.push(sentTexts(context));
        return step;
      };
    faux.setResponses([
      record(runCommand('cat notes.md', 'call-1', 35_000)),
      record(answer('## Asked\nA todo app.\n## Done\nThe list.')),
      record(answer('Carrying on with the form.')),
    ]);
    const harness = await conversationAgentHarness({
      faux,
      workspace: commandWorkspace(async () => ({ exitCode: 0, stdout: 'notes', stderr: '' })),
    });

    await send(harness, 'Build the todo form');
    await turnEnded(harness);

    expect(harness.agent.state.lastCompletedTurn).toMatchObject({ status: 'completed' });
    // The note is asked for after the conversation so far.
    expect(requests[1]?.at(-1)).toContain(HANDOFF_REQUEST);
    // The fresh context: the note, then the person's latest request, and nothing before them.
    const fresh = requests[2] ?? [];
    expect(fresh).toHaveLength(2);
    expect(fresh[0]).toContain('<handoff_note>\n## Asked\nA todo app.\n## Done\nThe list.\n</handoff_note>');
    expect(fresh[1]).toContain('Build the todo form');
    // The chat shows everything, the note where the conversation went on from it, and the request once.
    const messages = await harness.messages();
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    const parts = messages[1]?.parts ?? [];
    expect(parts.find((part) => part.type === HANDOFF_PART_TYPE)).toEqual({
      type: HANDOFF_PART_TYPE,
      data: { note: '## Asked\nA todo app.\n## Done\nThe list.' },
    });
    expect(parts.at(-1)).toMatchObject({ text: 'Carrying on with the form.' });
  });

  it('hands off once after the provider says the context is too long, and sends the request again', async () => {
    const faux = fauxProvider();
    faux.setResponses([
      runCommand('cat notes.md', 'call-1'),
      fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: 'prompt is too long: 210000 tokens > 200000 maximum',
      }),
      answer('## Asked\nA todo app.'),
      answer('Built the form.'),
    ]);
    const harness = await conversationAgentHarness({
      faux,
      workspace: commandWorkspace(async () => ({ exitCode: 0, stdout: 'notes', stderr: '' })),
    });

    await send(harness, 'Build the todo form');
    await turnEnded(harness);

    expect(harness.agent.state.lastCompletedTurn).toMatchObject({ status: 'completed', overflowHandedOff: true });
    expect(harness.agent.state.turnError).toBeNull();
    const parts = (await harness.messages())[1]?.parts ?? [];
    expect(parts.find((part) => part.type === HANDOFF_PART_TYPE)).toMatchObject({
      data: { note: '## Asked\nA todo app.' },
    });
    expect(parts.at(-1)).toMatchObject({ text: 'Built the form.' });
  });

  it('after a restart cut a command off, reports it interrupted to the model and finishes the turn', async () => {
    const faux = fauxProvider();
    let sent: string[] = [];
    faux.setResponses([
      runCommand('pnpm build', 'call-1'),
      (context) => {
        sent = sentTexts(context);
        return {
          ...fauxAssistantMessage(fauxText('The build was cut off; running it again next.')),
          usage: usageOf(100),
        };
      },
    ]);
    const running = deferred<void>();
    const harness = await conversationAgentHarness({
      faux,
      workspace: commandWorkspace(async () => {
        running.resolve();
        return new Promise(() => undefined);
      }),
    });
    await send(harness, 'Build it');
    await running.promise;

    // The object is evicted mid-command: a new instance starts on what the old one stored, which stays cut off.
    const restarted = await harness.restart();
    await eventually(() => restarted.state.activeTurn === null, 10_000);

    expect(restarted.state.lastCompletedTurn).toMatchObject({ status: 'completed' });
    expect(sent.some((text) => /interrupt/i.test(text))).toBe(true);
  });
});
