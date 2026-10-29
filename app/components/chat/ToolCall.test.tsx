// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { makePartId } from 'cloudchef-agent/partId';
import type {
  CloudflareExecutionPublicState,
  CloudflareRequestFiled,
  CloudflareRequestFinalResult,
} from 'cloudchef-agent/cloudflare-api';
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

  const deleteZone = { method: 'DELETE' as const, url: 'https://api.cloudflare.com/client/v4/zones/zone-1' };
  const execution = (
    overrides: Partial<CloudflareExecutionPublicState> & Pick<CloudflareExecutionPublicState, 'status'>,
  ): CloudflareExecutionPublicState => ({
    executionId: 'execution-1',
    toolCallId: 'exec-1',
    accountId: 'account-1',
    proposalSha256: 'a'.repeat(64),
    createdAt: Date.now(),
    decidedAt: null,
    startedAt: null,
    completedAt: null,
    expiresAt: Date.now() + 60_000,
    outcome: null,
    request: deleteZone,
    riskNote: 'This may delete an externally visible resource.',
    ...overrides,
  });
  /** What a finished command reports, with the changes it filed for a team's admins, or what they decided. */
  type CommandReport = {
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    cloudflareChanges?: (
      | CloudflareRequestFiled
      | (Omit<CloudflareRequestFinalResult, 'outcome'> & {
          outcome: { status: 'denied'; summary: string };
        })
    )[];
  };
  const command = (toolCallId: string, output?: CommandReport): CloudChefToolInvocation =>
    output === undefined
      ? {
          type: 'dynamic-tool',
          state: 'input-available',
          toolCallId,
          toolName: 'exec',
          input: { command: 'cf zones delete zone-1' },
        }
      : {
          type: 'dynamic-tool',
          state: 'output-available',
          toolCallId,
          toolName: 'exec',
          input: { command: 'cf zones delete zone-1' },
          output,
        };

  it('shows the exact change a running command waits on, and wires its approval', async () => {
    const decide = vi.fn(async () => ({ execution: execution({ status: 'succeeded' }) }));
    toolActivityStore.activities.set({});

    await act(async () =>
      root.render(
        <ToolCall
          partId={makePartId('message-1', 0)}
          invocation={command('exec-1')}
          cloudflareExecutions={[execution({ status: 'awaiting_approval' })]}
          onCloudflareExecutionDecision={decide}
        />,
      ),
    );

    expect(container.textContent).toContain('DELETE https://api.cloudflare.com/client/v4/zones/zone-1');
    expect(container.textContent).toContain('Digest: aaaaaaaaaaaa');
    expect(container.textContent).toContain('Account: account-1');
    expect(container.textContent).toContain('This may delete an externally visible resource.');
    const approve = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Approve'));
    await act(async () => approve?.click());

    expect(decide).toHaveBeenCalledWith('execution-1', 'approve');
  });

  it("shows each of a command's changes in its card, in the order it asked, the waiting one to decide", async () => {
    const decide = vi.fn(async () => ({ execution: execution({ status: 'succeeded' }) }));
    const later = execution({
      executionId: 'execution-2',
      status: 'awaiting_approval',
      createdAt: Date.now() + 1_000,
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/zones/zone-2' },
    });
    toolActivityStore.activities.set({});

    await act(async () =>
      root.render(
        <ToolCall
          partId={makePartId('message-4', 0)}
          invocation={command('exec-1')}
          cloudflareExecutions={[
            later,
            execution({ status: 'succeeded' }),
            execution({ executionId: 'other', toolCallId: 'exec-9', status: 'awaiting_approval' }),
          ]}
          onCloudflareExecutionDecision={decide}
        />,
      ),
    );

    const text = container.textContent ?? '';
    expect(text.indexOf('zones/zone-1')).toBeGreaterThan(-1);
    expect(text.indexOf('zones/zone-1')).toBeLessThan(text.indexOf('zones/zone-2'));
    expect(text).toContain('Cloudflare made the change.');
    expect(container.querySelectorAll('[data-testid="cloudflare-request-approval"]')).toHaveLength(2);
    const approve = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Approve'));
    await act(async () => approve?.click());

    expect(decide).toHaveBeenCalledWith('execution-2', 'approve');
  });

  it('shows an indeterminate change as something to check, with nothing left to approve', async () => {
    await act(async () =>
      root.render(
        <ToolCall
          partId={makePartId('message-2', 0)}
          invocation={command('exec-1', { command: 'cf zones delete zone-1', exitCode: 1, stdout: '', stderr: '' })}
          cloudflareExecutions={[
            execution({
              status: 'indeterminate',
              outcome: { status: 'indeterminate', summary: 'Interrupted; not replayed.' },
            }),
          ]}
        />,
      ),
    );
    await act(async () => container.querySelector('button')?.click());

    expect(container.textContent).toContain('It’s not known whether Cloudflare made the change');
    expect(container.textContent).toContain('Interrupted; not replayed.');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Approve'))).toBe(
      false,
    );
  });

  it("shows a team member's change as waiting for a team admin, with no buttons, then what came of it", async () => {
    const request = {
      method: 'POST' as const,
      url: 'https://api.cloudflare.com/client/v4/accounts/a/workers/domains',
    };
    const ran = { command: 'cf workers domains create', exitCode: 1, stdout: '', stderr: 'Not changed yet' };
    await act(async () =>
      root.render(
        <ToolCall
          partId={makePartId('message-3', 0)}
          invocation={command('exec-3', {
            ...ran,
            cloudflareChanges: [
              {
                kind: 'cloudflare_request_filed',
                status: 'awaiting_team_admin',
                approvalId: 'approval-1',
                accountId: 'a',
                request,
                riskNote: 'One of the team’s admins approves or rejects it.',
                expiresAt: Date.now() + 60_000,
                note: 'Filed.',
              },
            ],
          })}
          onCloudflareExecutionDecision={vi.fn()}
        />,
      ),
    );
    await act(async () => container.querySelector('button')?.click());

    expect(container.textContent).toContain('Waiting for a team admin to approve it.');
    expect(container.textContent).toContain('POST https://api.cloudflare.com/client/v4/accounts/a/workers/domains');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Approve'))).toBe(
      false,
    );

    await act(async () =>
      root.render(
        <ToolCall
          partId={makePartId('message-3', 0)}
          invocation={command('exec-3', {
            ...ran,
            cloudflareChanges: [
              {
                kind: 'cloudflare_request_final_result',
                executionId: 'approval-1',
                accountId: 'a',
                proposalSha256: 'c'.repeat(64),
                status: 'rejected',
                outcome: { status: 'denied', summary: 'A team admin rejected this change.' },
              },
            ],
          })}
        />,
      ),
    );
    expect(container.textContent).toContain('Rejected. Nothing was sent to Cloudflare.');
    expect(container.textContent).toContain('A team admin rejected this change.');
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
      toolName: 'exec',
      input: { command: 'cloudchef validate' },
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
      toolCallId: 'commit-2',
      toolName: 'commit',
      input: { message: 'Add a pricing page' },
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
    expect(container.textContent).toContain('Saving stopped');
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
      toolName: 'exec',
      input: { command: 'cloudchef validate' },
      output: { validation: { version: 1, ok: false, summary: 'Lint failed.' } },
    };
    await act(async () => root.render(<ToolCall partId={makePartId('message-15', 0)} invocation={invocation} />));
    expect(container.textContent).toContain('Checks failed');
    expect(container.textContent).not.toContain('Checked the project');
    expect(container.querySelector('.text-bolt-elements-icon-success')).toBeNull();
  });
});
