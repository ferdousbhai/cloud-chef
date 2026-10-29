import { memo, useEffect, useState } from 'react';
import { z } from 'zod';
import { isToolInvocationInProgress, type CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { isCloudChefToolResult, toolResultSucceeded, toolResultSummary } from 'cloudchef-agent/tool-result';
import { ToolResultFrame } from './ToolResultFrame';
import { attachedValidation } from './validation-verdict';
import { captureProductEvent } from '~/lib/telemetry.client';
import {
  cloudflareApiRequestDisplaySchema,
  type CloudflareApiRequestDisplay,
  type CloudflareExecutionDecisionHandler,
  type CloudflareExecutionPublicState,
} from 'cloudchef-agent/cloudflare-api';
import { Button } from '~/components/ui/primitives/Button';
import { isToolActivityStatusActive, type ToolActivityStatus } from '~/lib/common/types';
import type { LinkedPublishView } from '~/lib/common/linked-publish';
import { messageOf } from '~/lib/json-request';

export const ToolUseContents = memo(function ToolUseContents({
  invocation,
  status,
  progress,
  cloudflareExecutions,
  onCloudflareExecutionDecision,
  publish,
}: {
  invocation: CloudChefToolInvocation;
  status: ToolActivityStatus;
  progress?: unknown;
  /** The changes to the Cloudflare account this command asked for, in the order it asked. */
  cloudflareExecutions?: readonly CloudflareExecutionPublicState[];
  onCloudflareExecutionDecision?: CloudflareExecutionDecisionHandler;
  /** A team project's publish, as of now (useLinkedPublishView), or null for any other call. */
  publish: LinkedPublishView | null;
}) {
  // A stopped or finished call keeps whatever invocation state the provider last streamed, so the
  // invocation alone cannot say whether work is still happening. The card's own status can, and a
  // tool that is no longer running must never show the running placeholder.
  const running = isToolInvocationInProgress(invocation) && isToolActivityStatusActive(status);
  // The changes to the Cloudflare account the command asked for: each waiting for the person in its place, or decided.
  const change =
    invocation.toolName === 'exec' ? (
      <CloudflareChangeContents
        invocation={invocation}
        executions={cloudflareExecutions ?? []}
        onDecision={onCloudflareExecutionDecision}
      />
    ) : null;
  if (running) {
    return (
      <>
        <RunningToolContents invocation={invocation} progress={progress} />
        {change}
      </>
    );
  }
  if (isToolInvocationInProgress(invocation)) {
    return (
      <>
        <ToolResultFrame>{unfinishedToolSummary(status)}</ToolResultFrame>
        {change}
      </>
    );
  }
  if (attachedValidation(invocation)) {
    return <ValidationToolContents invocation={invocation} />;
  }
  if (invocation.toolName === 'publish' || invocation.toolName === 'publish_preview') {
    return publish ? <PublishContents view={publish} /> : <StructuredResultTool invocation={invocation} />;
  }
  if (invocation.toolName === 'exec') {
    // A command that pushed to the project: what became of the push first, then the command itself.
    return (
      <>
        {publish ? <PublishContents view={publish} /> : null}
        <StructuredResultTool invocation={invocation} />
        {change}
      </>
    );
  }
  return <StructuredResultTool invocation={invocation} />;
});

function unfinishedToolSummary(status: ToolActivityStatus): string {
  return status === 'aborted'
    ? 'Stopped before this tool returned a result.'
    : 'This tool call ended without a recorded result.';
}

function RunningToolContents({ invocation, progress }: { invocation: CloudChefToolInvocation; progress?: unknown }) {
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
    const replacement = input?.new_string ?? '';
    preview = replacement ? tailLines(replacement, 12) : path ? `Preparing an edit to ${path}` : 'Preparing an edit…';
  } else if (invocation.toolName === 'read') {
    preview = path ? `Reading ${path}` : 'Resolving file path…';
  } else {
    preview = 'Working…';
  }

  return (
    <ToolResultFrame>
      <pre
        aria-live="polite"
        className="max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word text-xs text-content-secondary"
      >
        {preview}
      </pre>
    </ToolResultFrame>
  );
}

/** A team member's change, filed for the team's admins, in the output of the command that asked. */
const cloudflareRequestFiledSchema = z.object({
  kind: z.literal('cloudflare_request_filed'),
  status: z.literal('awaiting_team_admin'),
  request: cloudflareApiRequestDisplaySchema,
  riskNote: z.string(),
});

/**
 * What became of a change the team's admins decided, in place of the filed one, or of one in the person's own
 * account that its command left waiting in the chat (shown by its own card while the chat still lists it).
 */
const cloudflareRequestFinalResultSchema = z.object({
  kind: z.literal('cloudflare_request_final_result'),
  executionId: z.string(),
  status: z.enum(['rejected', 'succeeded', 'failed', 'indeterminate', 'expired']),
  outcome: z.object({
    summary: z.string(),
    content: z.string().optional(),
  }),
});

const commandChangesSchema = z.looseObject({ cloudflareChanges: z.array(z.unknown()).optional() });

function CloudflareRequestLine({ request }: { request: CloudflareApiRequestDisplay }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-bolt-elements-borderColor p-3 text-xs leading-5 text-content-secondary">
      {`${request.method} ${request.url}`}
      {request.body === undefined ? '' : `\n\n${JSON.stringify(request.body, null, 2)}`}
    </pre>
  );
}

/**
 * The changes to the Cloudflare account a command asked for, if it asked for any: in the person's own account (or a
 * team's, for its admins) each waits here for their approval in turn while the command waits; a team member's show
 * that they went to the team's admins, then what they decided.
 */
function CloudflareChangeContents({
  invocation,
  executions,
  onDecision,
}: {
  invocation: CloudChefToolInvocation;
  executions: readonly CloudflareExecutionPublicState[];
  onDecision?: CloudflareExecutionDecisionHandler;
}) {
  const output = invocation.state === 'output-available' ? invocation.output : undefined;
  const shown = new Set(executions.map((execution) => execution.executionId));
  const filed = (commandChangesSchema.safeParse(output).data?.cloudflareChanges ?? []).filter((change) => {
    const executionId = cloudflareRequestFinalResultSchema.safeParse(change).data?.executionId;
    return executionId === undefined || !shown.has(executionId);
  });
  if (executions.length === 0 && filed.length === 0) {
    return null;
  }
  return (
    <>
      {executions.map((execution) => (
        <CloudflareApprovalContents key={execution.executionId} execution={execution} onDecision={onDecision} />
      ))}
      {filed.map((change, index) => (
        <TeamChangeContents key={index} change={change} />
      ))}
    </>
  );
}

/** One change a team member's command filed for the team's admins: waiting for them, or what they decided. */
function TeamChangeContents({ change }: { change: unknown }) {
  const filed = cloudflareRequestFiledSchema.safeParse(change).data;
  const final = cloudflareRequestFinalResultSchema.safeParse(change).data;
  if (!filed && !final) {
    return null;
  }
  return (
    <ToolResultFrame>
      <div className="space-y-3" data-testid="cloudflare-request-team-approval">
        {filed ? (
          <>
            <CloudflareRequestLine request={filed.request} />
            <p className="text-xs leading-5 text-content-secondary">{filed.riskNote}</p>
            <p className="text-content-primary" role="status">
              Waiting for a team admin to approve it.
            </p>
          </>
        ) : final ? (
          <CloudflareExecutionStatus
            status={final.status}
            outcome={{ status: 'success', summary: final.outcome.summary, content: final.outcome.content }}
          />
        ) : null}
      </div>
    </ToolResultFrame>
  );
}

function CloudflareApprovalContents({
  execution,
  onDecision,
}: {
  execution: CloudflareExecutionPublicState;
  onDecision?: CloudflareExecutionDecisionHandler;
}) {
  const [pendingDecision, setPendingDecision] = useState<'approve' | 'reject' | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  // Once its command's wait is over, a change goes on waiting here, with no deadline.
  const waitsInChat = execution.leftWaitingAt !== null;
  const { expiresAt } = execution;
  // The time the command's wait ran out; the change then waits in the chat.
  const [passedDeadline, setPassedDeadline] = useState<number | null>(() =>
    expiresAt <= Date.now() ? expiresAt : null,
  );
  useEffect(() => {
    const timeout = window.setTimeout(() => setPassedDeadline(expiresAt), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [expiresAt]);

  const canDecide = execution.status === 'awaiting_approval' && Boolean(onDecision) && pendingDecision === null;

  const decide = async (decision: 'approve' | 'reject') => {
    if (!onDecision || !canDecide) {
      return;
    }
    setPendingDecision(decision);
    setDecisionError(null);
    try {
      await onDecision(execution.executionId, decision);
    } catch (error) {
      setDecisionError(messageOf(error, 'Your decision couldn’t be saved. Try again.'));
    } finally {
      setPendingDecision(null);
    }
  };

  return (
    <ToolResultFrame>
      <div className="space-y-3" data-testid="cloudflare-request-approval">
        <div className="grid gap-1 text-xs text-content-tertiary">
          <div>Account: {execution.accountId}</div>
          <div>Digest: {execution.proposalSha256.slice(0, 12)}</div>
        </div>
        <CloudflareRequestLine request={execution.request} />
        <p className="text-xs leading-5 text-content-secondary">{execution.riskNote}</p>
        <CloudflareExecutionStatus
          status={execution.status}
          outcome={execution.outcome}
          waitsInChat={waitsInChat || passedDeadline === expiresAt}
        />
        {execution.status === 'awaiting_approval' ? (
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
  waitsInChat = false,
}: {
  status: CloudflareExecutionPublicState['status'];
  outcome: CloudflareExecutionPublicState['outcome'];
  /** The command that asked has stopped waiting for it, so it waits here. */
  waitsInChat?: boolean;
}) {
  const label =
    status === 'awaiting_approval'
      ? waitsInChat
        ? 'Waiting for your approval. The agent went on without it; approving sends it once, and the agent is told what happened.'
        : 'Waiting for your approval. The agent waits until you decide.'
      : status === 'approved' || status === 'executing'
        ? 'Approved. Sending exactly this request…'
        : status === 'rejected'
          ? 'Rejected. Nothing was sent to Cloudflare.'
          : status === 'expired'
            ? 'Withdrawn. Nothing was sent to Cloudflare.'
            : status === 'succeeded'
              ? 'Cloudflare made the change.'
              : status === 'indeterminate'
                ? 'It’s not known whether Cloudflare made the change. Check the account before trying again.'
                : 'The change didn’t go through.';
  const error = status === 'failed' || status === 'indeterminate' || status === 'expired';
  return (
    <div className="space-y-2" role="status">
      <p className={error ? 'text-bolt-elements-icon-error' : 'text-content-primary'}>{label}</p>
      {outcome?.summary ? <p className="text-xs text-content-secondary">{outcome.summary}</p> : null}
      {outcome?.content ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-break-word text-xs leading-5 text-content-secondary">
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
  new_string: optionalText,
});

const runningToolProgressSchema = z.looseObject({
  stdout: optionalText,
  stderr: optionalText,
  details: z.unknown().optional(),
});

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
function ValidationToolContents({ invocation }: { invocation: CloudChefToolInvocation }) {
  if (invocation.state === 'output-error') {
    return <ToolResultFrame>{invocation.errorText ?? 'Project validation failed.'}</ToolResultFrame>;
  }
  const result = attachedValidation(invocation);
  if (!result) {
    return <ToolResultFrame>{toolResultSummary(invocation.output)}</ToolResultFrame>;
  }
  const report = validationReportSchema.safeParse(result.data).data;
  const checks = report?.checks ?? [];
  return (
    <ToolResultFrame>
      <div className="space-y-2">
        <div className={result.ok ? 'text-content-primary' : 'text-bolt-elements-icon-error'}>
          {result.ok ? 'Checks passed.' : 'Checks failed.'}
          {report?.durationMs === undefined ? null : (
            <span className="ml-2 text-xs text-content-tertiary">{Math.round(report.durationMs / 1_000)}s</span>
          )}
        </div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word text-xs leading-5 text-content-secondary">
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

function StructuredResultTool({ invocation }: { invocation: CloudChefToolInvocation }) {
  const complete = !isToolInvocationInProgress(invocation);
  const succeeded = invocation.state === 'output-available' && toolResultSucceeded(invocation.output);
  const validationSucceeded = attachedValidation(invocation)?.ok === true;
  useEffect(() => {
    if (!complete) {
      return;
    }
    // Every completed tool card reaches this effect, so the once-per-journey claim
    // inside `captureProductEvent` is what keeps this a single funnel event.
    void captureProductEvent('first_tool_completed', {
      outcome: succeeded ? 'success' : 'failure',
    });
    if (validationSucceeded) {
      void captureProductEvent('validation_succeeded', { outcome: 'success' });
    }
  }, [complete, invocation.state, invocation.toolCallId, succeeded, validationSucceeded]);

  if (invocation.state === 'output-error') {
    return <ToolResultFrame>{invocation.errorText}</ToolResultFrame>;
  }
  if (!isCloudChefToolResult(invocation.output)) {
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

/** What became of a team project's publish, in the person's words, with the links its build reported. */
function PublishContents({ view }: { view: LinkedPublishView }) {
  return (
    <ToolResultFrame>
      <div className="space-y-2">
        <div>{view.detail}</div>
        <PublishLinks view={view} />
      </div>
    </ToolResultFrame>
  );
}

/** Only web links the build reported are offered (the view keeps nothing else). */
export function PublishLinks({ view }: { view: LinkedPublishView }) {
  if (!view.previewUrl && !view.detailsUrl) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {view.previewUrl ? (
        <a className="underline" href={view.previewUrl} target="_blank" rel="noopener noreferrer">
          Open the preview
        </a>
      ) : null}
      {view.detailsUrl ? (
        <a className="underline" href={view.detailsUrl} target="_blank" rel="noopener noreferrer">
          Details in Cloudflare
        </a>
      ) : null}
    </div>
  );
}
