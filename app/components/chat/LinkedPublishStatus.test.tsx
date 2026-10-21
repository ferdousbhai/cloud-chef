// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { toolSuccess } from 'cloudchef-agent/tool-result';
import { LinkedPublishStatus } from './LinkedPublishStatus';

function transcript(build: string, previewUrl: string | null): CloudChefMessage[] {
  return [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Change the hero' }] },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'publish_preview',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { message: 'Hero' },
          output: toolSuccess('model text', {
            branch: 'cloudchef/sara',
            commit: 'c'.repeat(40),
            live: false,
            build,
            previewUrl,
            detailsUrl: null,
            startedAt: Date.now(),
          }),
        },
      ],
    },
  ];
}

describe('LinkedPublishStatus', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('shows the build above the composer, then its preview link when the result lands after the turn', async () => {
    await act(async () => root.render(<LinkedPublishStatus messages={transcript('pending', null)} />));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Building a preview of cloudchef/sara');

    await act(async () =>
      root.render(<LinkedPublishStatus messages={transcript('success', 'https://abc.ada.workers.dev')} />),
    );
    expect(container.textContent).toContain('Preview ready on cloudchef/sara');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://abc.ada.workers.dev');
  });

  it('shows nothing before a publish reaches GitHub', async () => {
    await act(async () => root.render(<LinkedPublishStatus messages={[]} />));
    expect(container.textContent).toBe('');
  });
});
