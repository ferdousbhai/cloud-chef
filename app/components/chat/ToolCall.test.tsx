// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { makePartId } from 'cloudchef-agent/partId';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { ToolCall } from './ToolCall';

describe('ToolCall', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  it('renders an exact Cloudflare proposal and wires its durable approval decision', async () => {
    const invocation: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'cloudflare-execute-1',
      toolName: 'cloudflare_execute',
      input: { code: 'return await client.deleteZone("zone-1")' },
      output: {
        kind: 'cloudflare_execute_proposal',
        status: 'awaiting_approval',
        executionId: 'execution-1',
        toolCallId: 'cloudflare-execute-1',
        accountId: 'account-1',
        code: 'return await client.deleteZone("zone-1")',
        proposalSha256: 'a'.repeat(64),
        riskNote: 'This may delete an externally visible resource.',
        expiresAt: Date.now() + 60_000,
      },
    };
    const decide = vi.fn(async () => ({
      execution: {
        executionId: 'execution-1',
        toolCallId: 'cloudflare-execute-1',
        accountId: 'account-1',
        proposalSha256: 'a'.repeat(64),
        status: 'succeeded' as const,
        createdAt: Date.now(),
        decidedAt: Date.now(),
        startedAt: Date.now(),
        completedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        outcome: { status: 'success' as const, summary: 'done' },
      },
      resumeTurn: true,
    }));

    await act(async () =>
      root.render(
        <ToolCall
          partId={makePartId('message-1', 0)}
          invocation={invocation}
          cloudflareExecutions={[
            {
              executionId: 'execution-1',
              toolCallId: 'cloudflare-execute-1',
              accountId: 'account-1',
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
          onCloudflareExecutionDecision={decide}
        />,
      ),
    );
    await act(async () => container.querySelector('button')?.click());

    expect(container.textContent).toContain('return await client.deleteZone("zone-1")');
    expect(container.textContent).toContain('Digest: aaaaaaaaaaaa');
    expect(container.textContent).toContain('Account: account-1');
    const approve = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Approve'));
    await act(async () => approve?.click());

    expect(decide).toHaveBeenCalledWith('execution-1', 'approve');
  });

  it('renders an indeterminate Cloudflare execution as terminal reconciliation guidance', async () => {
    const invocation: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'cloudflare-execute-2',
      toolName: 'cloudflare_execute',
      input: { code: 'return mutate()' },
      output: {
        kind: 'cloudflare_execute_proposal',
        status: 'awaiting_approval',
        executionId: 'execution-2',
        toolCallId: 'cloudflare-execute-2',
        accountId: 'account-1',
        code: 'return mutate()',
        proposalSha256: 'b'.repeat(64),
        riskNote: 'risk',
        expiresAt: Date.now() + 60_000,
      },
    };
    await act(async () =>
      root.render(
        <ToolCall
          partId={makePartId('message-2', 0)}
          invocation={invocation}
          cloudflareExecutions={[
            {
              executionId: 'execution-2',
              toolCallId: 'cloudflare-execute-2',
              accountId: 'account-1',
              proposalSha256: 'b'.repeat(64),
              status: 'indeterminate',
              createdAt: Date.now(),
              decidedAt: Date.now(),
              startedAt: Date.now(),
              completedAt: Date.now(),
              expiresAt: Date.now() + 60_000,
              outcome: { status: 'indeterminate', summary: 'Interrupted; not replayed.' },
            },
          ]}
        />,
      ),
    );
    await act(async () => container.querySelector('button')?.click());

    expect(container.textContent).toContain('Outcome indeterminate');
    expect(container.textContent).toContain('Interrupted; not replayed.');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Approve'))).toBe(
      false,
    );
  });
  it('names the file a streaming write is filling, with how much has arrived', async () => {
    const invocation: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'input-streaming',
      toolCallId: 'write-1',
      toolName: 'write',
      input: { path: '/home/project/src/routes/index.tsx', content: 'x'.repeat(3_277) },
    };

    await act(async () => root.render(<ToolCall partId={makePartId('message-3', 0)} invocation={invocation} />));

    expect(container.textContent).toContain('Writing src/routes/index.tsx… 3.2 KB');
  });

  it('keeps the established wording until the streamed path is legible', async () => {
    const invocation: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'input-streaming',
      toolCallId: 'write-2',
      toolName: 'write',
      input: {},
    };

    await act(async () => root.render(<ToolCall partId={makePartId('message-4', 0)} invocation={invocation} />));

    expect(container.textContent).toContain('Writing a file…');
  });

  it("marks the validation the builder runs on the model's behalf as automatic", async () => {
    const invocation: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'auto-validate:0f8f0f0f',
      toolName: 'validate',
      input: {},
    };

    await act(async () => root.render(<ToolCall partId={makePartId('message-5', 0)} invocation={invocation} />));

    expect(container.textContent).toContain('Validating the project (automatic)…');
  });

  it('reports a finished validation as a verdict and its stages, not raw JSON', async () => {
    const invocation: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'validate-1',
      toolName: 'validate',
      input: {},
      output: {
        validation: {
          version: 1,
          ok: false,
          summary: 'Typecheck failed in src/routes/index.tsx.',
          data: {
            level: 'full',
            durationMs: 42_000,
            checks: [
              { name: 'typecheck', status: 'failed' },
              { name: 'lint', status: 'passed' },
            ],
          },
        },
      },
    };

    await act(async () => root.render(<ToolCall partId={makePartId('message-6', 0)} invocation={invocation} />));
    await act(async () => container.querySelector('button')?.click());

    expect(container.textContent).toContain('Validation failed.');
    expect(container.textContent).toContain('Typecheck failed in src/routes/index.tsx.');
    expect(container.textContent).toContain('typecheck');
    expect(container.textContent).toContain('lint');
    expect(container.textContent).not.toContain('"version": 1');
  });

  it('never shows the running placeholder for a tool the turn already stopped', async () => {
    const invocation: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'validate-2',
      toolName: 'validate',
      input: {},
    };
    const partId = makePartId('message-7', 0);
    toolActivityStore.record(partId, invocation);

    await act(async () => root.render(<ToolCall partId={partId} invocation={invocation} />));
    expect(container.textContent).toContain('Working…');
    // Pin the card open, so what is asserted afterwards is the body itself and not a collapse.
    await act(async () => container.querySelector('button')?.click());

    // The stop path marks the activity terminal while the invocation keeps the last state the
    // provider streamed, which is exactly how a finished card kept a "Working…" body.
    await act(async () => toolActivityStore.abortActive());

    expect(container.textContent).not.toContain('Working…');
    expect(container.textContent).toContain('Stopped before this tool returned a result.');
    expect(container.textContent).toContain('Validation stopped');
  });
});
