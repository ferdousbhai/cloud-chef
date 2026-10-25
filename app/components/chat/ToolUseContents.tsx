import { memo, useEffect, useState } from 'react';
import { z } from 'zod';
import { isToolInvocationInProgress, type CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { isCloudChefToolResult, toolResultSucceeded, toolResultSummary } from 'cloudchef-agent/tool-result';
import { ToolResultFrame } from './ToolResultFrame';
import { attachedValidation } from './validation-verdict';
import { captureProductEvent } from '~/lib/telemetry.client';
import {
  cloudflareApiRequestDisplaySchema,
  cloudflareApiRequestIsRead,
  type CloudflareApiRequestDisplay,
  type CloudflareExecutionDecisionHandler,
  type CloudflareExecutionPublicState,
} from 'cloudchef-agent/cloudflare-api';
import { Button } from '~/components/ui/primitives/Button';
import { isToolActivityStatusActive, type ToolActivityStatus } from '~/lib/common/types';
import type { LinkedPublishView } from '~/lib/common/linked-publish';
import { getRelativePath } from 'cloudchef-agent/utils/workDir';
import { messageOf } from '~/lib/json-request';

export const ToolUseContents = memo(function ToolUseContents({
  invocation,
  status,
  progress,
  cloudflareExecution,
  onCloudflareExecutionDecision,
  publish,
}: {
  invocation: CloudChefToolInvocation;
  status: ToolActivityStatus;
  progress?: unknown;
  cloudflareExecution?: CloudflareExecutionPublicState;
  onCloudflareExecutionDecision?: CloudflareExecutionDecisionHandler;
  /** A team project's publish, as of now (useLinkedPublishView), or null for any other call. */
  publish: LinkedPublishView | null;
}) {
  // A stopped or finished call keeps whatever invocation state the provider last streamed, so the
  // invocation alone cannot say whether work is still happening. The card's own status can, and a
  // tool that is no longer running must never show the running placeholder.
  const running = isToolInvocationInProgress(invocation) && isToolActivityStatusActive(status);
  if (invocation.toolName === 'cloudflare_request') {
    return (
      <CloudflareRequestContents
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
  if (invocation.toolName === 'publish' || invocation.toolName === 'publish_preview') {
    return publish ? <PublishContents view={publish} /> : <StructuredResultTool invocation={invocation} />;
  }
  if (
    invocation.toolName === 'read' ||
    invocation.toolName === 'write' ||
    invocation.toolName === 'edit' ||
    invocation.toolName === 'exec' ||
    invocation.toolName === 'search_cloudflare_docs' ||
    invocation.toolName === 'fetch_site'
  ) {
    return <StructuredResultTool invocation={invocation} />;
  }
  if (invocation.state === 'output-error') {
    return <ToolResultFrame>{invocation.errorText ?? 'This tool call failed.'}</ToolResultFrame>;
  }
  switch (invocation.toolName) {
    case 'ls':
      return <ListingContents invocation={invocation} />;
    case 'grep':
      return <SearchContents invocation={invocation} />;
    case 'history':
      return <HistoryContents invocation={invocation} />;
    default:
      return <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(invocation, null, 2)}</pre>;
  }
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
        className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs leading-[1.4] text-content-secondary"
      >
        {preview}
      </pre>
    </ToolResultFrame>
  );
}

const cloudflareRequestProposalSchema = z.object({
  kind: z.literal('cloudflare_request_proposal'),
  status: z.literal('awaiting_approval'),
  executionId: z.string(),
  toolCallId: z.string(),
  accountId: z.string(),
  request: cloudflareApiRequestDisplaySchema,
  proposalSha256: z.string(),
  riskNote: z.string(),
  expiresAt: z.number(),
});

const cloudflareRequestResultSchema = z.object({
  kind: z.literal('cloudflare_request_result'),
  status: z.enum(['success', 'failure', 'insufficient_scope']),
  accountId: z.string(),
  content: z.string().optional(),
  requestId: z.string().nullable(),
  httpStatus: z.number().nullable(),
  truncated: z.boolean(),
});

function CloudflareRequestLine({ request }: { request: CloudflareApiRequestDisplay }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bolt-elements-borderColor p-3 text-xs leading-5 text-content-secondary">
      {`${request.method} ${request.url}`}
      {request.body === undefined ? '' : `\n\n${JSON.stringify(request.body, null, 2)}`}
    </pre>
  );
}

function CloudflareRequestContents({
  invocation,
  running,
  execution,
  onDecision,
}: {
  invocation: CloudChefToolInvocation;
  running: boolean;
  execution?: CloudflareExecutionPublicState;
  onDecision?: CloudflareExecutionDecisionHandler;
}) {
  const input = cloudflareApiRequestDisplaySchema.safeParse(invocation.input).data;
  const output = invocation.state === 'output-available' ? invocation.output : undefined;
  const proposal = cloudflareRequestProposalSchema.safeParse(output).data;
  if (execution || proposal || (running && input && !cloudflareApiRequestIsRead(input))) {
    return (
      <CloudflareRequestApprovalContents
        invocation={invocation}
        input={input}
        proposal={proposal}
        running={running}
        execution={execution}
        onDecision={onDecision}
      />
    );
  }
  if (running) {
    return (
      <ToolResultFrame>
        <div className="space-y-1.5">
          <div className="text-content-secondary">Reading the connected Cloudflare account…</div>
          {input ? <CloudflareRequestLine request={input} /> : null}
        </div>
      </ToolResultFrame>
    );
  }
  if (invocation.state === 'output-error') {
    return <ToolResultFrame>{invocation.errorText ?? 'The Cloudflare API request failed.'}</ToolResultFrame>;
  }
  if (isToolInvocationInProgress(invocation)) {
    return <ToolResultFrame>{unfinishedToolSummary('aborted')}</ToolResultFrame>;
  }
  const result = cloudflareRequestResultSchema.safeParse(output).data;
  if (!result) {
    return <ToolResultFrame>The Cloudflare API returned an invalid result.</ToolResultFrame>;
  }
  return (
    <ToolResultFrame>
      <div className="space-y-1.5">
        <div className={result.status === 'success' ? 'text-content-primary' : 'text-bolt-elements-icon-error'}>
          {result.status === 'success'
            ? 'Cloudflare API request completed.'
            : result.status === 'insufficient_scope'
              ? 'The connected Cloudflare grant does not allow this request.'
              : 'The Cloudflare API request failed.'}
        </div>
        {input ? <CloudflareRequestLine request={input} /> : null}
        {result.content ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-[1.4] text-content-secondary">
            {result.content}
          </pre>
        ) : null}
        {result.truncated ? <div className="text-xs text-content-tertiary">Result was truncated.</div> : null}
      </div>
    </ToolResultFrame>
  );
}

function CloudflareRequestApprovalContents({
  invocation,
  running,
  execution,
  onDecision,
  input,
  proposal,
}: {
  invocation: CloudChefToolInvocation;
  running: boolean;
  execution?: CloudflareExecutionPublicState;
  onDecision?: CloudflareExecutionDecisionHandler;
  input?: CloudflareApiRequestDisplay;
  proposal?: z.infer<typeof cloudflareRequestProposalSchema>;
}) {
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
        <div className="space-y-1.5">
          <div className="text-content-secondary">Preparing a Cloudflare change for your approval…</div>
          {input ? <CloudflareRequestLine request={input} /> : null}
        </div>
      </ToolResultFrame>
    );
  }
  if (isToolInvocationInProgress(invocation) && !proposal && !execution) {
    return <ToolResultFrame>{unfinishedToolSummary('aborted')}</ToolResultFrame>;
  }
  if (invocation.state === 'output-error') {
    return <ToolResultFrame>{invocation.errorText ?? 'The Cloudflare change proposal failed.'}</ToolResultFrame>;
  }
  if (!proposal && !execution) {
    return <ToolResultFrame>The Cloudflare change proposal is unavailable.</ToolResultFrame>;
  }

  const executionId = proposal?.executionId ?? execution?.executionId ?? '';
  const request = proposal?.request ?? input;
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
      setDecisionError(messageOf(error, 'The Cloudflare execution decision failed.'));
    } finally {
      setPendingDecision(null);
    }
  };

  return (
    <ToolResultFrame>
      <div className="space-y-3" data-testid="cloudflare-request-approval">
        <div className="grid gap-1 text-xs text-content-tertiary">
          <div>Account: {accountId}</div>
          <div>Digest: {digest.slice(0, 12)}</div>
        </div>
        {request ? <CloudflareRequestLine request={request} /> : null}
        <p className="text-xs leading-5 text-content-secondary">
          {proposal?.riskNote ??
            'This exact request may make destructive, irreversible, or billable Cloudflare account changes.'}
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
        ? 'Approved. Sending the exact request…'
        : status === 'rejected'
          ? 'Rejected. Nothing was sent to Cloudflare.'
          : status === 'expired'
            ? 'Approval expired. Propose the change again to continue.'
            : status === 'succeeded'
              ? 'Cloudflare applied the change.'
              : status === 'indeterminate'
                ? 'Outcome indeterminate. Reconcile current state before proposing another change.'
                : 'The Cloudflare change failed.';
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

const MAX_LISTED_ROWS = 40;

const listingOutputSchema = z.looseObject({
  entries: z.array(z.looseObject({ path: z.string(), type: z.string() })),
  entryCount: z.number().optional(),
  truncated: z.boolean().optional(),
});

const searchOutputSchema = z.looseObject({
  matches: z.array(z.looseObject({ path: z.string(), line: z.number(), text: z.string() })),
  matchCount: z.number().optional(),
  truncated: z.boolean().optional(),
});

const historySearchOutputSchema = z.looseObject({
  totalMatches: z.number(),
  entries: z.array(z.looseObject({ role: z.string(), excerpt: z.string() })),
});
const historyReadOutputSchema = z.looseObject({ role: z.string(), text: z.string() });

function moreRows(shown: number, total: number, truncated: boolean | undefined): string | null {
  const hidden = total - shown;
  return hidden > 0 ? `…and ${hidden} more` : truncated ? '…and more' : null;
}

function ListingContents({ invocation }: { invocation: CloudChefToolInvocation }) {
  const listing = listingOutputSchema.safeParse(invocation.output).data;
  if (!listing) {
    return <ToolResultFrame>{toolResultSummary(invocation.output)}</ToolResultFrame>;
  }
  const shown = listing.entries.slice(0, MAX_LISTED_ROWS);
  const more = moreRows(shown.length, listing.entryCount ?? listing.entries.length, listing.truncated);
  return (
    <ToolResultFrame>
      {shown.length === 0 ? (
        'Nothing here.'
      ) : (
        <ul className="max-h-56 overflow-auto text-xs leading-5 text-content-secondary">
          {shown.map((entry) => (
            <li key={entry.path} className="truncate">
              {getRelativePath(entry.path) || entry.path}
              {entry.type === 'dir' ? '/' : ''}
            </li>
          ))}
          {more ? <li className="text-content-tertiary">{more}</li> : null}
        </ul>
      )}
    </ToolResultFrame>
  );
}

function SearchContents({ invocation }: { invocation: CloudChefToolInvocation }) {
  const search = searchOutputSchema.safeParse(invocation.output).data;
  if (!search) {
    return <ToolResultFrame>{toolResultSummary(invocation.output)}</ToolResultFrame>;
  }
  const shown = search.matches.slice(0, MAX_LISTED_ROWS);
  const more = moreRows(shown.length, search.matchCount ?? search.matches.length, search.truncated);
  return (
    <ToolResultFrame>
      {shown.length === 0 ? (
        'No matches.'
      ) : (
        <ul className="max-h-56 overflow-auto text-xs leading-5 text-content-secondary">
          {shown.map((match) => (
            <li key={`${match.path}:${match.line}`} className="truncate">
              <span className="text-content-primary">
                {getRelativePath(match.path) || match.path}:{match.line}
              </span>{' '}
              {match.text.trim()}
            </li>
          ))}
          {more ? <li className="text-content-tertiary">{more}</li> : null}
        </ul>
      )}
    </ToolResultFrame>
  );
}

const MAX_HISTORY_TEXT = 600;

function HistoryContents({ invocation }: { invocation: CloudChefToolInvocation }) {
  const search = historySearchOutputSchema.safeParse(invocation.output).data;
  if (search) {
    return (
      <ToolResultFrame>
        <div className="space-y-1 text-xs leading-5 text-content-secondary">
          <div>
            {search.totalMatches === 0
              ? 'Nothing earlier in the conversation matched.'
              : `${search.totalMatches} earlier message${search.totalMatches === 1 ? '' : 's'} matched.`}
          </div>
          {search.entries.slice(0, 5).map((entry, index) => (
            <p key={index} className="line-clamp-2">
              <span className="text-content-primary">{entry.role === 'user' ? 'You' : 'CloudChef'}:</span>{' '}
              {entry.excerpt}
            </p>
          ))}
        </div>
      </ToolResultFrame>
    );
  }
  const read = historyReadOutputSchema.safeParse(invocation.output).data;
  if (read) {
    return (
      <ToolResultFrame>
        <p className="whitespace-pre-wrap text-xs leading-5 text-content-secondary">
          {read.text.length > MAX_HISTORY_TEXT ? `${read.text.slice(0, MAX_HISTORY_TEXT)}…` : read.text}
        </p>
      </ToolResultFrame>
    );
  }
  return <ToolResultFrame>{toolResultSummary(invocation.output)}</ToolResultFrame>;
}
