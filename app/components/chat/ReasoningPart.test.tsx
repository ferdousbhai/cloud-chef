// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudChefPart } from 'cloudchef-agent/ai-compat';
import { ReasoningPart } from './ReasoningPart';

function reasoningPart(text: string, state: 'streaming' | 'done'): CloudChefPart {
  return { type: 'reasoning', text, state };
}

describe('ReasoningPart', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // SAFETY: React reads this act() flag off the global object, which carries no typing for it.
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('shows the newest reasoning while it streams, with the time spent so far', async () => {
    await act(async () => root.render(<ReasoningPart part={reasoningPart('Weighing the routes', 'streaming')} />));
    await act(async () => vi.advanceTimersByTimeAsync(12_000));

    expect(container.textContent).toContain('Thinking… 12s');
    expect(container.textContent).toContain('Weighing the routes');
  });

  it('collapses to how long the model thought once the reasoning ends', async () => {
    await act(async () => root.render(<ReasoningPart part={reasoningPart('Weighing the routes', 'streaming')} />));
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    await act(async () => root.render(<ReasoningPart part={reasoningPart('Weighing the routes', 'done')} />));

    expect(container.textContent).toContain('Thought for 9s');
    expect(container.textContent).not.toContain('Weighing the routes');
  });

  it('reports no duration for reasoning restored from the transcript, and expands to the full text', async () => {
    await act(async () => root.render(<ReasoningPart part={reasoningPart('Weighing the routes', 'done')} />));

    expect(container.textContent).toContain('Thought');
    expect(container.textContent).not.toContain('Thought for');

    await act(async () => container.querySelector('button')?.click());

    expect(container.textContent).toContain('Weighing the routes');
  });
});
