// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import type { BuildProgress } from './build-progress';
import { useBuildProgress } from './useBuildProgress';

let progress: BuildProgress | null = null;

function Harness({ messages }: { messages: CloudChefMessage[] }) {
  progress = useBuildProgress({
    streamStatus: 'streaming',
    isRecovering: false,
    isProjectUpdate: false,
    activeToolNames: [],
    validationStage: null,
    toolActivityRevision: 0,
    toolProgressRevision: 0,
    messages,
  });
  return null;
}

describe('useBuildProgress', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // SAFETY: React reads this act() flag off the global object, which carries no typing for it.
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    progress = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  const render = async (messages: CloudChefMessage[]) => {
    await act(async () => root.render(<Harness messages={messages} />));
  };

  it('names the wait while the model is reasoning, with the time it has been reasoning', async () => {
    await render([reasoningMessage('Considering the routes', 'streaming')]);

    await act(async () => vi.advanceTimersByTimeAsync(12_000));

    expect(progress).toMatchObject({ phase: 'thinking', message: 'Thinking… 12s', delayed: false });
  });

  it('restarts the quiet clock when reasoning tokens keep arriving', async () => {
    await render([reasoningMessage('Considering', 'streaming')]);

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(progress?.delayed).toBe(true);
    expect(progress?.message).toContain('no new update');

    await render([reasoningMessage('Considering the routes as well', 'streaming')]);

    expect(progress?.delayed).toBe(false);
    expect(progress?.message).toContain('Thinking…');
  });

  it('ignores stale reasoning once a later part arrives', async () => {
    const message = reasoningMessage('Earlier reasoning', 'streaming');
    await render([message]);
    await render([{ ...message, parts: [...message.parts, { type: 'text', text: 'Working now', state: 'done' }] }]);
    expect(progress).toMatchObject({ phase: 'creating' });
  });

  it('leaves the phase alone once the reasoning part has ended', async () => {
    await render([reasoningMessage('Considered', 'done')]);

    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(progress).toMatchObject({ phase: 'creating' });
  });
});

function reasoningMessage(text: string, state: 'streaming' | 'done'): CloudChefMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    parts: [{ type: 'reasoning', text, state }],
  };
}
