// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatStore } from '~/lib/stores/chatId';
import { activityRevealStore } from '~/lib/stores/activity-reveal';
import StreamingIndicator, { STATUS_MESSAGES } from './StreamingIndicator';

describe('StreamingIndicator', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // SAFETY: React reads this act() flag off the global object, which carries no typing for it.
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    chatStore.setKey('aborted', false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('shows the reason the stream reported rather than a generic label', async () => {
    await renderError('The model did not start responding within a minute. Retry, or pick a different model.');

    expect(container.textContent).toContain('The model did not start responding within a minute.');
    expect(container.textContent).not.toContain(STATUS_MESSAGES.error);
  });

  it('bounds a long provider rejection body', async () => {
    const reason = `Provider rejected the request: ${'x'.repeat(1_000)}`;

    await renderError(reason);

    const text = container.textContent ?? '';
    expect(text).toContain('Provider rejected the request:');
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(reason.length);
  });

  it('falls back to the generic label only when the failure says nothing', async () => {
    await renderError('   ');

    expect(container.textContent).toContain(STATUS_MESSAGES.error);
  });

  it('links the working status to the Activity panel', async () => {
    await act(async () =>
      root.render(
        <StreamingIndicator
          streamStatus="streaming"
          buildProgress={{ phase: 'thinking', message: 'Thinking… 12s', delayed: false }}
          isProjectUpdate={false}
          submissionPending={false}
          resendMessage={vi.fn()}
        />,
      ),
    );
    const link = container.querySelector<HTMLButtonElement>('button[title="Show in Activity"]');
    expect(link?.textContent).toBe('Thinking… 12s');

    const before = activityRevealStore.get();
    await act(async () => link?.click());
    expect(activityRevealStore.get()).toBe(before + 1);
  });

  it('keeps a failure as plain text rather than a link', async () => {
    await renderError('The model hit a limit.');

    expect(container.querySelector('button[title="Show in Activity"]')).toBeNull();
  });

  async function renderError(message: string) {
    await act(async () =>
      root.render(
        <StreamingIndicator
          streamStatus="error"
          currentError={new Error(message)}
          buildProgress={null}
          isProjectUpdate={false}
          submissionPending={false}
          resendMessage={vi.fn()}
        />,
      ),
    );
  }
});
