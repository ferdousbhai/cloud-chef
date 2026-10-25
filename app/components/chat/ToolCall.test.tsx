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
      toolCallId: 'cloudflare-request-1',
      toolName: 'cloudflare_request',
      input: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/zones/zone-1' },
      output: {
        kind: 'cloudflare_request_proposal',
        status: 'awaiting_approval',
        executionId: 'execution-1',
        toolCallId: 'cloudflare-request-1',
        accountId: 'account-1',
        request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/zones/zone-1' },
        proposalSha256: 'a'.repeat(64),
        riskNote: 'This may delete an externally visible resource.',
        expiresAt: Date.now() + 60_000,
      },
    };
    const decide = vi.fn(async () => ({
      execution: {
        executionId: 'execution-1',
        toolCallId: 'cloudflare-request-1',
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
              toolCallId: 'cloudflare-request-1',
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

    expect(container.textContent).toContain('DELETE https://api.cloudflare.com/client/v4/zones/zone-1');
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
      toolCallId: 'cloudflare-request-2',
      toolName: 'cloudflare_request',
      input: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/zones/zone-1' },
      output: {
        kind: 'cloudflare_request_proposal',
        status: 'awaiting_approval',
        executionId: 'execution-2',
        toolCallId: 'cloudflare-request-2',
        accountId: 'account-1',
        request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/zones/zone-1' },
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
              toolCallId: 'cloudflare-request-2',
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

    expect(container.textContent).toContain('Checks failed.');
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
    expect(container.textContent).toContain('Checks stopped');
  });
  it('titles a publish by what happened to it, and links what the build reported instead of dumping it', async () => {
    const failed: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'publish-1',
      toolName: 'publish',
      input: { message: 'Update the hero' },
      output: { version: 1, ok: false, summary: 'Nothing has changed since this workspace was opened.' },
    };
    await act(async () => root.render(<ToolCall partId={makePartId('message-8', 0)} invocation={failed} />));
    expect(container.textContent).toContain('Not published');

    const deployFailed: CloudChefToolInvocation = {
      ...failed,
      toolCallId: 'publish-3',
      output: {
        version: 1,
        ok: false,
        summary: "Committed merged into main, but the pipeline's build failed.",
        data: {
          branch: 'cloudchef/sara',
          commit: 'c'.repeat(40),
          live: true,
          build: 'failure',
          previewUrl: null,
          detailsUrl: 'https://dash.cloudflare.com/builds/1',
          defaultBranch: 'main',
        },
      },
    };
    await act(async () => root.render(<ToolCall partId={makePartId('message-13', 0)} invocation={deployFailed} />));
    expect(container.textContent).toContain('Publishing failed');
    expect(container.textContent).not.toContain('Not published');

    const sent: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'publish-preview-1',
      toolName: 'publish_preview',
      input: { message: 'Update the hero' },
      output: {
        version: 1,
        ok: true,
        summary: 'Committed on the branch cloudchef/sara; the pipeline built it. Tell the user.',
        data: {
          branch: 'cloudchef/sara',
          commit: 'c'.repeat(40),
          live: false,
          build: 'success',
          previewUrl: 'https://cloudchef-ada-site.ada.workers.dev',
          detailsUrl: 'javascript:alert(1)',
        },
      },
    };
    await act(async () => root.render(<ToolCall partId={makePartId('message-9', 0)} invocation={sent} />));
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toContain('Preview ready');
    const links = [...container.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')]);
    expect(links).toEqual([['Open the preview', 'https://cloudchef-ada-site.ada.workers.dev']]);
    expect(container.textContent).not.toContain('"commit"');
    expect(container.textContent).not.toContain('Tell the user');
  });

  it("shows a team project's preview as being made until its build result lands, and names the site page it read", async () => {
    const building: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'publish-preview-2',
      toolName: 'publish_preview',
      input: { message: 'Update the hero' },
      output: {
        version: 1,
        ok: true,
        summary: "Committed on the branch cloudchef/sara. Don't wait or poll for it.",
        data: {
          branch: 'cloudchef/sara',
          commit: 'c'.repeat(40),
          live: false,
          build: 'pending',
          previewUrl: null,
          detailsUrl: null,
          startedAt: Date.now(),
        },
      },
    };
    await act(async () => root.render(<ToolCall partId={makePartId('message-10', 0)} invocation={building} />));
    expect(container.textContent).toContain('Making a preview…');
    expect(container.querySelector('.text-bolt-elements-icon-success')).toBeNull();
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).not.toContain("Don't wait or poll");

    const live: CloudChefToolInvocation = {
      ...building,
      toolName: 'publish',
      toolCallId: 'publish-2',
      output: {
        version: 1,
        ok: true,
        summary: 'Committed.',
        data: {
          branch: 'cloudchef/sara',
          commit: 'c'.repeat(40),
          live: true,
          build: 'pending',
          previewUrl: null,
          detailsUrl: null,
          startedAt: Date.now(),
          defaultBranch: 'main',
        },
      },
    };
    await act(async () => root.render(<ToolCall partId={makePartId('message-11', 0)} invocation={live} />));
    expect(container.textContent).toContain('Publishing…');
  });

  it("stops spinning on a team project's build CloudChef no longer follows", async () => {
    const stale: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'publish-preview-3',
      toolName: 'publish_preview',
      input: { message: 'Update the hero' },
      output: {
        version: 1,
        ok: true,
        summary: 'Committed.',
        data: {
          branch: 'cloudchef/sara',
          commit: 'c'.repeat(40),
          live: false,
          build: 'pending',
          previewUrl: null,
          detailsUrl: null,
          startedAt: Date.now() - 5 * 60 * 60_000,
        },
      },
    };
    await act(async () => root.render(<ToolCall partId={makePartId('message-14', 0)} invocation={stale} />));
    expect(container.textContent).toContain('Sent for a preview');
    expect(container.textContent).not.toContain('Making a preview');
  });

  it('titles a failed validation as failed, with no success check', async () => {
    const invocation: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'validate-3',
      toolName: 'validate',
      input: {},
      output: { validation: { version: 1, ok: false, summary: 'Lint failed.' } },
    };
    await act(async () => root.render(<ToolCall partId={makePartId('message-15', 0)} invocation={invocation} />));
    expect(container.textContent).toContain('Checks failed');
    expect(container.textContent).not.toContain('Checked the project');
    expect(container.querySelector('.text-bolt-elements-icon-success')).toBeNull();
  });

  it('shows listings, searches, and history as readable rows, not JSON', async () => {
    const listing: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'ls-1',
      toolName: 'ls',
      input: { path: '/home/project/src' },
      output: {
        path: '/home/project/src',
        recursive: false,
        entries: [
          { path: '/home/project/src/routes', type: 'dir' },
          { path: '/home/project/src/main.tsx', type: 'file' },
        ],
        entryCount: 2,
        truncated: false,
        revision: 3,
      },
    };
    await act(async () =>
      root.render(<ToolCall partId={makePartId('message-16', 0)} invocation={listing} key={listing.toolCallId} />),
    );
    await act(async () => container.querySelector('button')?.click());
    // A fresh card per invocation (key), and the expanded body may load lazily: wait for it.
    await vi.waitFor(() => expect(container.textContent).toContain('src/routes/'));
    expect(container.textContent).toContain('src/main.tsx');
    expect(container.textContent).not.toContain('"entries"');

    const search: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'grep-1',
      toolName: 'grep',
      input: { pattern: 'hero' },
      output: {
        pattern: 'hero',
        path: '/home/project',
        matches: [{ path: '/home/project/src/main.tsx', line: 12, text: '  const hero = 1;' }],
        matchCount: 1,
        filesScanned: 4,
        filesSkipped: 0,
        truncated: false,
        revision: 3,
      },
    };
    await act(async () =>
      root.render(<ToolCall partId={makePartId('message-17', 0)} invocation={search} key={search.toolCallId} />),
    );
    await act(async () => container.querySelector('button')?.click());
    await vi.waitFor(() => expect(container.textContent).toContain('src/main.tsx:12'));
    expect(container.textContent).not.toContain('"matches"');

    const history: CloudChefToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'history-1',
      toolName: 'history',
      input: { op: 'search', query: 'pricing page' },
      output: {
        totalMatches: 1,
        nextOffset: null,
        entries: [{ id: 'live-1', role: 'user', excerpt: 'Add a pricing page' }],
      },
    };
    await act(async () =>
      root.render(<ToolCall partId={makePartId('message-18', 0)} invocation={history} key={history.toolCallId} />),
    );
    await act(async () => container.querySelector('button')?.click());
    await vi.waitFor(() => expect(container.textContent).toContain('Searched the conversation for pricing page'));
    expect(container.textContent).toContain('1 earlier message matched.');
    expect(container.textContent).not.toContain('"totalMatches"');
  });
});
