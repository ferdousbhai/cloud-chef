import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { StatusBadge } from '~/components/settings/SettingsLayout';
import {
  decideApproval,
  loadApprovals,
  type Approval,
  type Approvals as ApprovalsList,
  type ProductionRequest,
} from '~/lib/cloudflare/approvals.client';
import { messageOf, noContentSchema, postJson } from '~/lib/json-request';

/**
 * The Approvals page: what members of the person's teams asked an admin for. A change to the team's Cloudflare
 * account is sent by CloudChef, once, when an admin approves it; a request to make a draft a team project is
 * approved or declined here too.
 */
export function Approvals() {
  const [approvals, setApprovals] = useState<ApprovalsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = () => {
    setError(null);
    setAttempt((count) => count + 1);
  };

  useEffect(() => {
    const controller = new AbortController();
    loadApprovals(controller.signal)
      .then(setApprovals)
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(messageOf(cause, 'Approvals could not be loaded. Try again.'));
        }
      });
    return () => controller.abort();
  }, [attempt]);

  const waitingCount = (approvals?.waiting.length ?? 0) + (approvals?.productionRequests.length ?? 0);

  return (
    <main className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8 sm:px-6">
      <div className="grid gap-1">
        <h1 className="text-lg font-semibold text-content-primary">Approvals</h1>
        <p className="text-sm text-content-secondary">
          What your teams’ members asked an admin for. Approving a change has CloudChef make it in the team’s Cloudflare
          account, exactly as shown, once.
        </p>
      </div>
      {error !== null ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-content-secondary">
          <span>{error}</span>
          <Button size="xs" variant="neutral" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : approvals === null ? (
        <p className="text-sm text-content-tertiary" role="status">
          Loading approvals…
        </p>
      ) : !approvals.admin ? (
        <p className="text-sm text-content-secondary">
          You’re not an admin of any team, so nothing waits for you here.
        </p>
      ) : (
        <>
          <section className="grid gap-3" aria-label="Waiting">
            <h2 className="text-sm font-medium text-content-primary">
              Waiting <span className="font-normal text-content-tertiary">{waitingCount}</span>
            </h2>
            {waitingCount === 0 ? (
              <p className="text-sm text-content-secondary">Nothing is waiting for you.</p>
            ) : (
              <ul className="grid gap-3">
                {approvals.waiting.map((approval) => (
                  <WaitingChange key={approval.id} approval={approval} onDecided={reload} />
                ))}
                {approvals.productionRequests.map((pending) => (
                  <ProductionRequestRow key={pending.id} pending={pending} onDecided={reload} />
                ))}
              </ul>
            )}
          </section>
          {approvals.decided.length > 0 ? (
            <section className="grid gap-3" aria-label="Decided">
              <h2 className="text-sm font-medium text-content-primary">Decided lately</h2>
              <ul className="grid divide-y divide-bolt-elements-borderColor rounded-md border border-bolt-elements-borderColor">
                {approvals.decided.map((approval) => (
                  <DecidedChange key={approval.id} approval={approval} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

/** What a change does, in a word, from its method. */
function changeVerb(method: string): string {
  return method === 'DELETE' ? 'Delete' : method === 'POST' ? 'Create' : 'Change';
}

/** The request's path in the Cloudflare API, without the API's own prefix. */
function apiPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname.replace(/^\/client\/v4/, '')}${parsed.search}`;
}

function RequestDetails({ request }: { request: Approval['request'] }) {
  return (
    <details className="text-xs text-content-secondary">
      <summary className="cursor-pointer">Show the exact request</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bolt-elements-borderColor p-3 leading-5">
        {`${request.method} ${request.url}`}
        {request.body === undefined ? '' : `\n\n${JSON.stringify(request.body, null, 2)}`}
      </pre>
    </details>
  );
}

function WaitingChange({ approval, onDecided }: { approval: Approval; onDecided: () => void }) {
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const decide = async (decision: 'approve' | 'reject') => {
    setDeciding(decision);
    setProblem(null);
    try {
      await decideApproval(approval.id, decision);
      onDecided();
    } catch (cause) {
      setProblem(messageOf(cause, 'That couldn’t be saved. Try again.'));
    } finally {
      setDeciding(null);
    }
  };
  const who = approval.requester.name || approval.requester.email;
  const title = `${changeVerb(approval.request.method)} ${apiPath(approval.request.url)}`;
  return (
    <li className="grid min-w-0 gap-2 rounded-md border border-accent-500/40 bg-bolt-elements-background-depth-2 p-3 text-sm [overflow-wrap:anywhere]">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusBadge tone="warning">Cloudflare change</StatusBadge>
        <span className="text-xs text-content-tertiary">
          {approval.orgName} · from {who} · {timeAgo(approval.createdAt)}
        </span>
      </span>
      <strong className="min-w-0 font-mono text-xs">{title}</strong>
      {approval.warning ? <p className="text-xs text-content-primary">{approval.warning}</p> : null}
      <p className="text-xs text-content-secondary">
        {who}’s agent asked for this. It may change, delete or add costs to things in the team’s account.
      </p>
      <RequestDetails request={approval.request} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="primary"
          loading={deciding === 'approve'}
          disabled={deciding !== null}
          aria-label={`Approve: ${title}`}
          onClick={() => void decide('approve')}
        >
          Approve
        </Button>
        <Button
          size="xs"
          variant="neutral"
          loading={deciding === 'reject'}
          disabled={deciding !== null}
          aria-label={`Reject: ${title}`}
          onClick={() => void decide('reject')}
        >
          Reject
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-bolt-elements-icon-error">
          {problem}
        </p>
      ) : null}
    </li>
  );
}

function DecidedChange({ approval }: { approval: Approval }) {
  const who = approval.requester.name || approval.requester.email;
  const label =
    approval.status === 'rejected'
      ? `Rejected by ${approval.decidedBy ?? 'an admin'}`
      : approval.status === 'expired'
        ? 'Expired: no admin decided in time'
        : approval.status === 'sending'
          ? `Approved by ${approval.decidedBy ?? 'an admin'}, sending…`
          : approval.result === 'succeeded'
            ? `Approved by ${approval.decidedBy ?? 'an admin'}, and Cloudflare made the change`
            : approval.result === 'indeterminate'
              ? `Approved by ${approval.decidedBy ?? 'an admin'}, but CloudChef couldn’t tell whether Cloudflare made it`
              : `Approved by ${approval.decidedBy ?? 'an admin'}, but Cloudflare refused it`;
  const color =
    approval.status === 'done' && approval.result === 'succeeded'
      ? 'text-content-success'
      : approval.status === 'done'
        ? 'text-content-error'
        : 'text-content-secondary';
  return (
    <li className="grid min-w-0 gap-1 px-3 py-2 text-sm [overflow-wrap:anywhere]">
      <span className="font-mono text-xs text-content-primary">
        {changeVerb(approval.request.method)} {apiPath(approval.request.url)}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-content-tertiary">
        <span className={color}>{label}</span>
        {approval.orgName} · from {who} · {timeAgo(approval.decidedAt ?? approval.createdAt)}
      </span>
      {approval.status === 'done' && approval.result !== 'succeeded' && approval.outcome ? (
        <span className="text-xs text-content-secondary">{approval.outcome.summary}</span>
      ) : null}
    </li>
  );
}

const approvedSchema = z.object({ projectId: z.string() });

/** A member's request to make a draft a team project, as an admin decides it. */
function ProductionRequestRow({ pending, onDecided }: { pending: ProductionRequest; onDecided: () => void }) {
  const [approving, setApproving] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [decisionNote, setDecisionNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setProblem(null);
    try {
      await action();
      onDecided();
    } catch (cause) {
      setProblem(messageOf(cause, 'That couldn’t be saved. Try again.'));
    }
  };
  const approve = async () => {
    setApproving(true);
    await run(async () => {
      await postJson(
        '/api/organizations/production-requests/approve',
        { orgId: pending.orgId, requestId: pending.id },
        approvedSchema,
      );
    });
    setApproving(false);
  };
  const decline = () =>
    void run(async () => {
      await postJson(
        '/api/organizations/production-requests/decline',
        { orgId: pending.orgId, requestId: pending.id, note: decisionNote.trim() },
        noContentSchema,
      );
    });
  const who = pending.requesterName || pending.requesterEmail;
  return (
    <li className="grid min-w-0 gap-1.5 rounded-md border border-accent-500/40 bg-bolt-elements-background-depth-2 p-3 text-sm [overflow-wrap:anywhere]">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusBadge tone="warning">Team project request</StatusBadge>
        <span className="text-xs text-content-tertiary">
          {pending.orgName} · from {who} · {timeAgo(pending.updatedAt ?? pending.createdAt)}
        </span>
      </span>
      <strong className="min-w-0">{pending.title}</strong>
      <span className="text-xs text-content-secondary">
        {who} asks to make this draft one of the team’s projects. Approving makes it a team project they can edit.
      </span>
      {pending.note ? <span className="text-xs text-content-secondary">{pending.note}</span> : null}
      {pending.previewUrl ? (
        <a className="text-xs underline" href={pending.previewUrl} target="_blank" rel="noopener noreferrer">
          Try the draft
        </a>
      ) : null}
      {declining ? (
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            maxLength={1_000}
            placeholder="Why, for them (optional)"
            aria-label={`Note to ${who} about ${pending.title}`}
            value={decisionNote}
            onChange={(event) => setDecisionNote(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button size="xs" variant="danger" aria-label={`Decline request: ${pending.title}`} onClick={decline}>
            Decline request
          </Button>
          <Button size="xs" variant="subtle" onClick={() => setDeclining(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="primary"
            loading={approving}
            aria-label={`Approve: ${pending.title}`}
            onClick={() => void approve()}
          >
            Approve
          </Button>
          <Button
            size="xs"
            variant="neutral"
            disabled={approving}
            aria-label={`Decline ${pending.title}`}
            onClick={() => setDeclining(true)}
          >
            Decline
          </Button>
        </div>
      )}
      {problem ? (
        <p role="alert" className="text-xs text-bolt-elements-icon-error">
          {problem}
        </p>
      ) : null}
    </li>
  );
}

/** How long ago a moment was, roughly: "just now", "5 min ago", "3 h ago", "2 days ago". */
function timeAgo(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
