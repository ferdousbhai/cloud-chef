// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudChefPart, CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { AssistantMessage } from './AssistantMessage';
import { describeFileGroup, groupMessageParts } from './FileToolGroup';

function filePart(toolName: 'read' | 'write' | 'edit', toolCallId: string, path: string): CloudChefPart {
  return {
    type: 'dynamic-tool',
    toolName,
    toolCallId,
    state: 'output-available',
    input: toolName === 'write' ? { path, content: 'hello' } : { path },
    output: { summary: 'done' },
  };
}

function invocation(toolName: string): CloudChefToolInvocation {
  return {
    type: 'dynamic-tool',
    state: 'output-available',
    toolCallId: `${toolName}-1`,
    toolName,
    input: {},
  };
}

describe('describeFileGroup', () => {
  it('summarizes a mixed run in plain verbs', () => {
    expect(describeFileGroup([invocation('read'), invocation('edit'), invocation('write')])).toBe(
      'Read 1 file, edited 1 file, wrote 1 file',
    );
  });

  it('pluralizes repeated verbs', () => {
    expect(describeFileGroup([invocation('edit'), invocation('edit'), invocation('write')])).toBe(
      'Edited 2 files, wrote 1 file',
    );
    expect(describeFileGroup([invocation('read'), invocation('read')])).toBe('Read 2 files');
  });
});

describe('groupMessageParts', () => {
  it('folds consecutive file tools and leaves the rest single', () => {
    const parts = [
      filePart('read', 'r1', 'src/a.css'),
      filePart('edit', 'e1', 'src/a.css'),
      {
        type: 'dynamic-tool',
        toolName: 'validate',
        toolCallId: 'v1',
        state: 'output-available',
        input: {},
      },
      filePart('write', 'w1', 'src/b.css'),
    ];
    const blocks = groupMessageParts(parts);
    expect(blocks.length).toBe(3);
    expect(blocks[0].kind).toBe('file-group');
    expect(blocks[1]).toMatchObject({ kind: 'single', index: 2 });
    // A lone trailing file tool stays a single card.
    expect(blocks[2]).toMatchObject({ kind: 'single', index: 3 });
  });

  it('does not group across text parts', () => {
    const parts = [
      filePart('read', 'r1', 'src/a.css'),
      { type: 'text', text: 'hello' },
      filePart('read', 'r2', 'src/b.css'),
    ];
    expect(groupMessageParts(parts).every((block) => block.kind === 'single')).toBe(true);
  });
});

describe('AssistantMessage file grouping', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    window.scrollTo = () => undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    toolActivityStore.activities.set({});
    toolActivityStore.startTurn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('renders one summary row for back-to-back file tools and expands to the details', async () => {
    await act(async () =>
      root.render(
        <AssistantMessage
          message={{
            id: 'message-1',
            role: 'assistant',
            parts: [
              filePart('read', 'r1', 'src/a.css'),
              filePart('write', 'w1', 'src/b.css'),
              {
                type: 'dynamic-tool',
                toolName: 'validate',
                toolCallId: 'v1',
                state: 'output-available',
                input: {},
                output: { summary: 'ok' },
              },
            ],
          }}
        />,
      ),
    );

    expect(container.textContent).toContain('Read 1 file, wrote 1 file');
    expect(container.textContent).toContain('Validated the project');
    expect(container.textContent).not.toContain('Read src/a.css');

    await act(async () => container.querySelector('button')?.click());

    expect(container.textContent).toContain('Read src/a.css');
    expect(container.textContent).toContain('Wrote src/b.css');
  });
});
