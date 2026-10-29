// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { toolSuccess } from 'cloudchef-agent/tool-result';
import { hasRunNarrative, RunNarrative } from './RunNarrative';

let container: HTMLDivElement;
let root: Root;
const message: CloudChefMessage = {
  id: 'assistant',
  role: 'assistant',
  parts: [
    { type: 'text', text: 'Let me check the template.', state: 'done' },
    {
      type: 'dynamic-tool',
      toolName: 'read',
      toolCallId: 'read-1',
      state: 'output-available',
      input: {},
      output: toolSuccess('Done'),
    },
    { type: 'text', text: 'Now the stylesheet.', state: 'done' },
    { type: 'text', text: '  ', state: 'done' },
    { type: 'text', text: 'Done. The preview is publishing.', state: 'done' },
  ],
};

// RunNarrative loads Markdown lazily; warm the module so a busy full-suite run doesn't outlast vi.waitFor.
beforeAll(async () => {
  await import('./Markdown');
});

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

it('shows only the latest narrative and reveals earlier updates on request', async () => {
  await act(async () => root.render(<RunNarrative parts={message.parts} />));
  await vi.waitFor(() => expect(container.textContent).toContain('Done. The preview is publishing.'));
  expect(container.textContent).not.toContain('Let me check the template.');
  expect(container.textContent).not.toContain('Now the stylesheet.');

  const toggle = container.querySelector('button');
  expect(toggle?.textContent).toBe('Show details');
  await act(async () => toggle?.click());
  await vi.waitFor(() => expect(container.textContent).toContain('Let me check the template.'));
  expect(container.textContent).toContain('Now the stylesheet.');
  expect(toggle?.textContent).toBe('Hide details');
});

it('omits the details link when the run has a single update', async () => {
  await act(async () => root.render(<RunNarrative parts={[message.parts[0]]} />));
  await vi.waitFor(() => expect(container.textContent).toContain('Let me check the template.'));
  expect(container.querySelector('button')).toBeNull();
});

it('shows a handoff note it went on from as a closed item, and the note as markdown once opened', async () => {
  const parts: CloudChefMessage['parts'] = [
    { type: 'text', text: 'Working.', state: 'done' },
    { type: 'data-handoff', data: { note: '## Done\n- The **form**' } },
    { type: 'text', text: 'Carrying on.', state: 'done' },
  ];
  expect(hasRunNarrative([{ type: 'data-handoff', data: { note: 'Only the note' } }])).toBe(true);

  await act(async () => root.render(<RunNarrative parts={parts} />));
  const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
  expect(toggle?.textContent).toContain('Continued from a handoff note');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  expect(container.textContent).not.toContain('The form');

  await act(async () => toggle?.click());
  await vi.waitFor(() => expect(container.querySelector('h2')?.textContent).toBe('Done'));
  expect(container.querySelector('strong')?.textContent).toBe('form');
});
