import { memo, useEffect, useState } from 'react';
import { z } from 'zod';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { isGhostbuildToolResult, toolResultSucceeded, toolResultSummary } from 'ghostbuild-agent/tool-result';
import { ToolResultFrame } from './ToolResultFrame';
import { captureProductEvent } from '~/lib/telemetry.client';
import type {
  CloudflareExecutionDecisionHandler,
  CloudflareExecutionPublicState,
} from 'ghostbuild-agent/cloudflare-mcp';
import { Button } from '~/components/ui/primitives/Button';
import { isToolActivityStatusActive, type ToolActivityStatus } from '~/lib/common/types';

export const ToolUseContents = memo(function ToolUseContents({
  invocation,
  status,
  progress,
  cloudflareExecution,
  onCloudflareExecutionDecision,
}: {
  invocation: GhostbuildToolInvocation;
  status: ToolActivityStatus;
  progress?: unknown;
  cloudflareExecution?: CloudflareExecutionPublicState;
  onCloudflareExecutionDecision?: CloudflareExecutionDecisionHandler;
}) {
  // A stopped or finished call keeps whatever invocation state the provider last streamed, so the
  // invocation alone cannot say whether work is still happening. The card's own status can, and a
  // tool that is no longer running must never show the running placeholder.
  const running = isToolInvocationInProgress(invocation) && isToolActivityStatusActive(status);
  if (
    invocation.toolName === 'cloudflare_docs' ||
    invocation.toolName === 'cloudflare_search' ||
    invocation.toolName === 'cloudflare_execute'
  ) {
    return (
      <CloudflareMcpToolContents
        invocation={invocation}
        running={running}
        execution={cloudflareExecution}
        onDecision={onCloudflareExecutionDecision}
      />
    );
  }
  if (running) {
    return <RunningToolContents invocation={invocation} progress={progress} />;
  }
  if (isToolInvocationInProgress(invocation)) {
    return <ToolResultFrame>{unfinishedToolSummary(status)}</ToolResultFrame>;
  }
  if (invocation.toolName === 'validate') {
    return <ValidationToolContents invocation={invocation} />;
  }
  return invocation.toolName === 'read' ||
    invocation.toolName === 'write' ||
    invocation.toolName === 'edit' ||
    invocation.toolName === 'exec' ||
    invocation.toolName === 'search_cloudflare_docs' ? (
    <StructuredResultTool invocation={invocation} />
  ) : (
    <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(invocation, null, 2)}</pre>
  );
});

function unfinishedToolSummary(status: ToolActivityStatus): string {
  return status === 'aborted'
    ? 'Stopped before this tool returned a result.'
    : 'This tool call ended without a recorded result.';
}

function RunningToolContents({ invocation, progress }: { invocation: GhostbuildToolInvocation; progress?: unknown }) {
  const input = runningToolInputSchema.safeParse(invocation.input).data;
  const progressRecord = runningToolProgressSchema.safeParse(progress).data;
  const details = runningToolProgressSchema.safeParse(progressRecord?.details).data ?? progressRecord;
  const path = input?.path;
  let preview = '';

  if (invocation.toolName === 'exec') {
    const command = input?.command ?? '';
    const stdout = details?.stdout ?? '';
    const stderr = details?.stderr ?? '';
    preview = [`$ ${command || '…'}`, stdout, stderr].filter(Boolean).join('\n');
  } else if (invocation.toolName === 'write') {
    const content = input?.content ?? '';
    preview = content ? tailLines(content, 12) : path ? `Preparing ${path}` : 'Preparing file content…';
  } else if (invocation.toolName === 'edit') {
    const edits = input?.edits ?? [];
    preview =
      edits.length > 0 ? JSON.stringify(edits, null, 2) : path ? `Preparing edits for ${path}` : 'Preparing edits…';
  } else if (invocation.toolName === 'read') {
    preview = path ? `Reading ${path}` : 'Resolving file path…';
  } else {
    preview = 'Working…';
  }

  return (
    <ToolResultFrame>
      <pre
        aria-live="polite"
        className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-content-secondary"
      >
        {preview}
      </pre>
    </ToolResultFrame>
  );
}

const cloudflareExecuteProposalSchema = z.object({
  kind: z.literal('cloudflare_execute_proposal'),
  status: z.literal('awaiting_approval'),
  executionId: z.string(),
  toolCallId: z.string(),
  accountId: z.string(),
  code: z.string(),
  proposalSha256: z.string(),
  riskNote: z.string(),
  expiresAt: z.number(),
});

const cloudflareMcpResultSchema = z.object({
  kind: z.literal('cloudflare_mcp_result'),
  operation: z.enum(['docs', 'search']),
  status: z.enum(['success', 'failure', 'insufficient_scope']),
  accountId: z.string(),
  content: z.string().optional(),
  requestId: z.string().nullable(),
  httpStatus: z.number().nullable(),
  truncated: z.boolean(),
});

const cloudflareToolInputSchema = z.looseObject({
  query: z.string().optional(),
  code: z.string().optional(),
});

function CloudflareMcpToolContents({
  invocation,
  running,
  execution,
  onDecision,
}: {
  invocation: GhostbuildToolInvocation;
  running: boolean;
  execution?: CloudflareExecutionPublicState;
  onDecision?: CloudflareExecutionDecisionHandler;
}) {
  if (invocation.toolName === 'cloudflare_execute') {
    return (
      <CloudflareExecuteContents
        invocation={invocation}
        running={running}
        execution={execution}
        onDecision={onDecision}
      />
    );
  }
  const input = cloudflareToolInputSchema.safeParse(invocation.input).data;
  if (running) {
    const activity = invocation.toolName === 'cloudflare_docs' ? input?.query : input?.code;
    return (
      <ToolResultFrame>
        <div className="space-y-2">
          <div className="text-content-secondary">
            {invocation.toolName === 'cloudflare_docs'
              ? 'Searching Cloudflare documentation…'
              : 'Searching the authenticated Cloudflare account…'}
          </div>
          {activity ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">{activity}</pre> : null}
        </div>
      </ToolResultFrame>
    );
  }
  if (invocation.state === 'output-error') {
    return <ToolResultFrame>{invocation.errorText ?? 'Cloudflare MCP failed.'}</ToolResultFrame>;
  }
  if (isToolInvocationInProgress(invocation)) {
    return <ToolResultFrame>{unfinishedToolSummary('aborted')}</ToolResultFrame>;
  }
  const result =
    invocation.state === 'output-available' ? cloudflareMcpResultSchema.safeParse(invocation.output).data : null;
  if (!result) {
    return <ToolResultFrame>Cloudflare MCP returned an invalid result.</ToolResultFrame>;
  }
  return (
    <ToolResultFrame>
      <div className="space-y-2">
        <div className={result.status === 'success' ? 'text-content-primary' : 'text-bolt-elements-icon-error'}>
          {result.status === 'success'
            ? 'Cloudflare MCP completed.'
            : result.status === 'insufficient_scope'
              ? 'The connected Cloudflare grant does not include the required scope.'
              : 'Cloudflare MCP failed.'}
        </div>
        <div className="text-xs text-content-tertiary">Account: {result.accountId}</div>
        {result.content ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-content-secondary">
            {result.content}
          </pre>
        ) : null}
        {result.truncated ? <div className="text-xs text-content-tertiary">Result was truncated.</div> : null}
      </div>
    </ToolResultFrame>
  );
}

function CloudflareExecuteContents({
  invocation,
  running,
  execution,
  onDecision,
}: {
  invocation: GhostbuildToolInvocation;
  running: boolean;
  execution?: CloudflareExecutionPublicState;
  onDecision?: CloudflareExecutionDecisionHandler;
}) {
  const proposal =
    invocation.state === 'output-available'
      ? cloudflareExecuteProposalSchema.safeParse(invocation.output).data
      : undefined;
  const input = cloudflareToolInputSchema.safeParse(invocation.input).data;
  const [pendingDecision, setPendingDecision] = useState<'approve' | 'reject' | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [expired, setExpired] = useState(() => (proposal?.expiresAt ?? execution?.expiresAt ?? Infinity) <= Date.now());
  const expiresAt = proposal?.expiresAt ?? execution?.expiresAt;
  useEffect(() => {
    if (!expiresAt || expiresAt <= Date.now()) {
      setExpired(Boolean(expiresAt));
      return undefined;
    }
    const timeout = window.setTimeout(() => setExpired(true), expiresAt - Date.now());
    return () => window.clearTimeout(timeout);
  }, [expiresAt]);

  if (running) {
    return (
      <ToolResultFrame>
        <div className="space-y-2">
          <div className="text-content-secondary">Preparing an approval-bound Cloudflare execution…</div>
          {input?.code ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{input.code}</pre>
          ) : null}
        </div>
      </ToolResultFrame>
    );
  }
  if (isToolInvocationInProgress(invocation) && !proposal && !execution) {
    return <ToolResultFrame>{unfinishedToolSummary('aborted')}</ToolResultFrame>;
  }
  if (invocation.state === 'output-error') {
    return <ToolResultFrame>{invocation.errorText ?? 'The Cloudflare execution proposal failed.'}</ToolResultFrame>;
  }
  if (!proposal && !execution) {
    return <ToolResultFrame>The Cloudflare execution proposal is unavailable.</ToolResultFrame>;
  }

  const executionId = proposal?.executionId ?? execution?.executionId ?? '';
  const code = proposal?.code ?? input?.code ?? '';
  const accountId = proposal?.accountId ?? execution?.accountId ?? '';
  const digest = proposal?.proposalSha256 ?? execution?.proposalSha256 ?? '';
  const status = execution?.status ?? 'awaiting_approval';
  const effectiveStatus = status === 'awaiting_approval' && expired ? 'expired' : status;
  const canDecide = effectiveStatus === 'awaiting_approval' && Boolean(onDecision) && pendingDecision === null;

  const decide = async (decision: 'approve' | 'reject') => {
    if (!onDecision || !canDecide) {
      return;
    }
    setPendingDecision(decision);
    setDecisionError(null);
    try {
      await onDecision(executionId, decision);
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : 'The Cloudflare execution decision failed.');
    } finally {
      setPendingDecision(null);
    }
  };

  return (
    <ToolResultFrame>
      <div className="space-y-3" data-testid="cloudflare-execute-approval">
        <div className="grid gap-1 text-xs text-content-tertiary">
          <div>Account: {accountId}</div>
          <div>Digest: {digest.slice(0, 12)}</div>
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bolt-elements-borderColor p-3 text-xs leading-5 text-content-secondary">
          {code}
        </pre>
        <p className="text-xs leading-5 text-content-secondary">
          {proposal?.riskNote ??
            'This exact generated code may make destructive, irreversible, or billable Cloudflare API changes.'}
        </p>
        <CloudflareExecutionStatus status={effectiveStatus} outcome={execution?.outcome ?? null} />
        {effectiveStatus === 'awaiting_approval' ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!canDecide}
              loading={pendingDecision === 'approve'}
              aria-busy={pendingDecision === 'approve'}
              onClick={() => void decide('approve')}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="neutral"
              disabled={!canDecide}
              loading={pendingDecision === 'reject'}
              aria-busy={pendingDecision === 'reject'}
              onClick={() => void decide('reject')}
            >
              Reject
            </Button>
          </div>
        ) : null}
        {decisionError ? <p className="text-xs text-bolt-elements-icon-error">{decisionError}</p> : null}
      </div>
    </ToolResultFrame>
  );
}

function CloudflareExecutionStatus({
  status,
  outcome,
}: {
  status: CloudflareExecutionPublicState['status'];
  outcome: CloudflareExecutionPublicState['outcome'];
}) {
  const label =
    status === 'awaiting_approval'
      ? 'Waiting for approval.'
      : status === 'approved' || status === 'executing'
        ? 'Approved. Executing the exact digest…'
        : status === 'rejected'
          ? 'Rejected. No Cloudflare execution was performed.'
          : status === 'expired'
            ? 'Approval expired. Propose the operation again to continue.'
            : status === 'succeeded'
              ? 'Cloudflare execution succeeded.'
              : status === 'indeterminate'
                ? 'Outcome indeterminate. Reconcile current state before proposing another mutation.'
                : 'Cloudflare execution failed.';
  const error = status === 'failed' || status === 'indeterminate' || status === 'expired';
  return (
    <div className="space-y-2" role="status">
      <p className={error ? 'text-bolt-elements-icon-error' : 'text-content-primary'}>{label}</p>
      {outcome?.summary ? <p className="text-xs text-content-secondary">{outcome.summary}</p> : null}
      {outcome?.content ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-content-secondary">
          {outcome.content}
        </pre>
      ) : null}
      {outcome?.sensitiveContentWithheld ? (
        <p className="text-xs text-bolt-elements-icon-error">Sensitive-looking response content was withheld.</p>
      ) : null}
    </div>
  );
}

function tailLines(value: string, limit: number): string {
  const lines = value.split('\n');
  const visible = lines.slice(-limit).join('\n');
  return lines.length > limit ? `… ${lines.length - limit} earlier lines\n${visible}` : visible;
}

/**
 * A streaming tool call carries partially-formed arguments and progress, so every field is read
 * best-effort: a field with the wrong shape falls back to absent rather than discarding the rest.
 */
const optionalText = z.string().optional().catch(undefined);

const runningToolInputSchema = z.looseObject({
  path: optionalText,
  command: optionalText,
  content: optionalText,
  edits: z.array(z.unknown()).optional().catch(undefined),
});

const runningToolProgressSchema = z.looseObject({
  stdout: optionalText,
  stderr: optionalText,
  details: z.unknown().optional(),
});

const validationOutputSchema = z.looseObject({ validation: z.unknown().optional() });

/** The canonical validation reports its pipeline; anything it does not report is simply absent. */
const validationReportSchema = z.looseObject({
  durationMs: z.number().optional().catch(undefined),
  checks: z
    .array(z.looseObject({ name: z.string(), status: z.string() }))
    .max(64)
    .optional()
    .catch(undefined),
});

/**
 * A finished validation is a verdict plus the stages behind it, not a JSON dump. The stage list is
 * what makes a failure actionable, so it is rendered when the result carries one and skipped
 * silently when it does not.
 */
function ValidationToolContents({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.state === 'output-error') {
    return <ToolResultFrame>{invocation.errorText ?? 'Project validation failed.'}</ToolResultFrame>;
  }
  if (invocation.state === 'output-denied') {
    return <ToolResultFrame>{invocation.approval?.reason ?? 'Project validation was denied.'}</ToolResultFrame>;
  }
  const attached = validationOutputSchema.safeParse(invocation.output).data?.validation;
  const result = isGhostbuildToolResult(attached)
    ? attached
    : isGhostbuildToolResult(invocation.output)
      ? invocation.output
      : null;
  if (!result) {
    return <ToolResultFrame>{toolResultSummary(invocation.output)}</ToolResultFrame>;
  }
  const report = validationReportSchema.safeParse(result.data).data;
  const checks = report?.checks ?? [];
  return (
    <ToolResultFrame>
      <div className="space-y-2">
        <div className={result.ok ? 'text-content-primary' : 'text-bolt-elements-icon-error'}>
          {result.ok ? 'Validation passed.' : 'Validation failed.'}
          {report?.durationMs === undefined ? null : (
            <span className="ml-2 text-xs text-content-tertiary">{Math.round(report.durationMs / 1_000)}s</span>
          )}
        </div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-content-secondary">
          {result.summary}
        </pre>
        {checks.length > 0 ? (
          <ul className="grid gap-1 text-xs text-content-secondary">
            {checks.map((check) => (
              <li key={check.name} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={
                    check.status === 'passed' ? 'text-bolt-elements-icon-success' : 'text-bolt-elements-icon-error'
                  }
                >
                  {check.status === 'passed' ? '✓' : '✗'}
                </span>
                <span className="truncate">{check.name}</span>
                <span className="ml-auto shrink-0 text-content-tertiary">{check.status}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </ToolResultFrame>
  );
}

function StructuredResultTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  const complete = !isToolInvocationInProgress(invocation);
  const succeeded = invocation.state === 'output-available' && toolResultSucceeded(invocation.output);
  const validation =
    invocation.state === 'output-available'
      ? validationOutputSchema.safeParse(invocation.output).data?.validation
      : undefined;
  const validationSucceeded = isGhostbuildToolResult(validation) && validation.ok;
  useEffect(() => {
    if (!complete) {
      return;
    }
    // Every completed tool card reaches this effect, so the once-per-journey claim
    // inside `captureProductEvent` is what keeps this a single funnel event.
    void captureProductEvent('first_tool_completed', {
      outcome: succeeded ? 'success' : invocation.state === 'output-denied' ? 'cancelled' : 'failure',
    });
    if (validationSucceeded) {
      void captureProductEvent('validation_succeeded', { outcome: 'success' });
    }
  }, [complete, invocation.state, invocation.toolCallId, succeeded, validationSucceeded]);

  if (invocation.state === 'output-error') {
    return <ToolResultFrame>{invocation.errorText}</ToolResultFrame>;
  }
  if (invocation.state === 'output-denied') {
    return <ToolResultFrame>{invocation.approval?.reason ?? 'Tool execution was denied.'}</ToolResultFrame>;
  }
  if (!isGhostbuildToolResult(invocation.output)) {
    return <ToolResultFrame>{toolResultSummary(invocation.output)}</ToolResultFrame>;
  }
  return (
    <ToolResultFrame>
      <div className="space-y-2">
        <div>{invocation.output.summary}</div>
        {invocation.output.coverage !== undefined ? (
          <pre className="whitespace-pre-wrap">{JSON.stringify(invocation.output.coverage, null, 2)}</pre>
        ) : null}
        {invocation.output.data !== undefined ? (
          <pre className="whitespace-pre-wrap">{JSON.stringify(invocation.output.data, null, 2)}</pre>
        ) : null}
      </div>
    </ToolResultFrame>
  );
}
