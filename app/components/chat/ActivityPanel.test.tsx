// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CloudChefMessage, CloudChefPart } from 'cloudchef-agent/ai-compat';
import { toolFailure, toolSuccess } from 'cloudchef-agent/tool-result';
import { ActivityPanel } from './ActivityPanel';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';

let container: HTMLDivElement;
let root: Root;
const tool = (name: string, id: string, path?: string): CloudChefPart => ({
  type: 'dynamic-tool',
  toolName: name,
  toolCallId: id,
  state: 'output-available',
  input: path ? { path, content: 'hello' } : {},
  output: toolSuccess('Done'),
});
const message: CloudChefMessage = {
  id: 'assistant',
  role: 'assistant',
  parts: [
    { type: 'text', text: 'Your app is ready.', state: 'done' },
    tool('write', 'write-1', 'src/index.ts'),
    tool('write', 'write-2', 'src/index.ts'),
    tool('validate', 'validate-1'),
  ],
};

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  toolActivityStore.activities.set({});
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

it('collapses finished tool history into an accurate summary without duplicating the narrative', async () => {
  await act(async () => root.render(<ActivityPanel messages={[message]} isStreaming={false} compact={false} />));
  expect(container.textContent).toContain('3 tool steps · 1 file changed · Validation passed');
  expect(container.textContent).not.toContain('Your app is ready.');
  expect(container.querySelector('.tool-call-card')).toBeNull();
  await act(async () => container.querySelector('button')?.click());
  expect(container.querySelector('.tool-call-card')).not.toBeNull();
  expect(container.textContent).not.toContain('Your app is ready.');
});

it('reports the latest validation failure rather than an earlier success', async () => {
  const failed: CloudChefMessage = {
    ...message,
    parts: [...message.parts, { ...tool('validate', 'validate-2'), output: toolFailure('Type error') }],
  };
  await act(async () => root.render(<ActivityPanel messages={[failed]} isStreaming={false} compact={false} />));
  expect(container.textContent).toContain('Validation failed');
  expect(container.textContent).not.toContain('Validation passed');
});

it('keeps compact activity closed until requested', async () => {
  await act(async () => root.render(<ActivityPanel messages={[message]} isStreaming={false} compact />));
  expect(container.textContent).not.toContain('3 tool steps');
  await act(async () => container.querySelector('button')?.click());
  expect(container.textContent).toContain('3 tool steps');
});

it('keeps current reasoning visible and older steps in a separate disclosure', async () => {
  const current: CloudChefMessage = {
    ...message,
    parts: [...message.parts, { type: 'reasoning', text: 'Checking the app', state: 'streaming' }],
  };
  await act(async () => root.render(<ActivityPanel messages={[current]} isStreaming compact={false} />));
  expect(container.textContent).toContain('Current work');
  expect(container.textContent).toContain('Thinking');
  expect(container.querySelector('details')?.open).toBe(false);
  expect(container.querySelector('details')?.textContent).not.toContain('Thinking');
});

it('keeps pending approvals visible even in the compact panel', async () => {
  const proposal: CloudChefMessage = {
    id: 'proposal',
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: 'cloudflare_execute',
        toolCallId: 'approval-call',
        state: 'output-available',
        input: { code: 'return 1' },
        output: {
          kind: 'cloudflare_execute_proposal',
          status: 'awaiting_approval',
          executionId: 'approval',
          toolCallId: 'approval-call',
          accountId: 'account',
          code: 'return 1',
          proposalSha256: 'a'.repeat(64),
          riskNote: 'Review this action.',
          expiresAt: Date.now() + 60_000,
        },
      },
    ],
  };
  await act(async () =>
    root.render(
      <ActivityPanel
        messages={[proposal]}
        isStreaming={false}
        compact
        cloudflareExecutions={[
          {
            executionId: 'approval',
            toolCallId: 'approval-call',
            accountId: 'account',
            proposalSha256: 'a'.repeat(64),
            status: 'awaiting_approval',
            createdAt: Date.now(),
            decidedAt: null,
            startedAt: null,
            completedAt: null,
            expiresAt: Date.now() + 60_000,
            outcome: null,
          },
        ]}
      />,
    ),
  );
  expect(container.textContent).toContain('Approval needed');
  expect(container.textContent).toContain('Review this action.');
});
