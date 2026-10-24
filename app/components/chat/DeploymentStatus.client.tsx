import { useEffect, useState, type FormEvent } from 'react';
import type { BuilderDeploymentState } from '~/agents/builder-deployment-command';
import { publicationStageLabel, type BuilderPublicationState } from '~/agents/builder-publication-progress';
import { Button } from '~/components/ui/primitives/Button';
import { captureProductEvent } from '~/lib/telemetry.client';
import { TextInput } from '@ui/TextInput';
import { authClient } from '~/lib/auth-client';
import { Modal } from '@ui/Modal';
import { messageOf } from '~/lib/json-request';

/** A new request for the admins, this draft's waiting request replaced with the revision sent, or no change. */
export type ProductionRequestOutcome = keyof typeof SENT_MESSAGES;

const SENT_MESSAGES = {
  requested: "Sent to your team's admins for review.",
  updated: 'Updated your request: your admins now see this version.',
  unchanged: 'Your admins already have this version.',
} as const;

/**
 * An admin approves requests themselves, so theirs isn't "sent to your admins": it waits in Settings, under the
 * team's GitHub projects, where approving it creates the repository.
 */
const ADMIN_SENT_MESSAGES = {
  requested: "Added to your team's production requests. Approve it in Settings to create its repository.",
  updated: 'Updated your request: Settings now shows this version to approve.',
  unchanged: 'Settings already shows this version to approve.',
} as const satisfies Record<ProductionRequestOutcome, string>;

export function DeploymentStatus({
  deployment,
  publication,
  onRetry,
  onRequestProduction,
}: {
  deployment: BuilderDeploymentState;
  publication?: BuilderPublicationState | null;
  onRetry: () => Promise<BuilderDeploymentState>;
  onRequestProduction: (input: { title: string; note: string }) => Promise<ProductionRequestOutcome>;
}) {
  const { data: session } = authClient.useSession();
  // In an organization's account, a deployed draft can be sent to its admins to become a real project.
  const organization = session?.context?.kind === 'organization' ? session.context : null;
  const admin = organization?.role === 'admin';
  const stage = publicationStageLabel(publication ?? null);
  useEffect(() => {
    if (deployment.status === 'succeeded') {
      void captureProductEvent('deployment_succeeded', { outcome: 'success' });
    }
  }, [deployment.status]);

  return (
    <section
      data-testid="deployment-status"
      // The browser gate reads this to prove production carries the revision that was saved.
      data-workspace-revision={deployment.workspaceRevision}
      className="mt-2 break-words space-y-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2.5 text-[13px]"
    >
      {deployment.status === 'succeeded' ? (
        <p className="text-bolt-elements-icon-success">
          Deployed.
          {deployment.productionUrl ? (
            <a className="ml-1 underline" href={deployment.productionUrl} target="_blank" rel="noreferrer">
              View app
            </a>
          ) : null}
        </p>
      ) : null}
      {deployment.status === 'succeeded' && deployment.error ? (
        // A step after production went live failed; the next deployment repeats it.
        <p className="text-content-secondary">{deployment.error}</p>
      ) : null}
      {deployment.status === 'succeeded' && organization ? (
        <RequestProduction admin={admin} onRequest={onRequestProduction} />
      ) : null}
      {deployment.status === 'succeeded' ? null : deployment.status === 'failed' ? (
        <>
          <h3 className="text-content-primary font-medium">Deployment failed</h3>
          {deployment.error ? <p className="text-bolt-elements-icon-error">{deployment.error}</p> : null}
          <RetryDeployment onRetry={onRetry} />
        </>
      ) : (
        <p className="text-content-secondary" role="status" aria-live="polite">
          {stage ?? 'Deploying…'}
        </p>
      )}
    </section>
  );
}

/** Starts the deployment again, saying while it's being asked for and why if it couldn't be. */
function RetryDeployment({ onRetry }: { onRetry: () => Promise<BuilderDeploymentState> }) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      await onRetry();
    } catch (failure) {
      setError(messageOf(failure, 'The deployment could not be started again.'));
    } finally {
      setRetrying(false);
    }
  };
  return (
    <>
      {error ? (
        <p className="text-bolt-elements-icon-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button size="sm" loading={retrying} onClick={() => void retry()}>
        Try again
      </Button>
    </>
  );
}

/**
 * Sends a deployed draft to the organization's admins, who can make it a real project on GitHub. The
 * form opens in a dialog: in the composer's dock it pushed the composer off a short phone screen. Sent
 * again from the same chat, the draft replaces its request while it waits, so admins see the latest.
 */
function RequestProduction({
  admin,
  onRequest,
}: {
  admin: boolean;
  onRequest: (input: { title: string; note: string }) => Promise<ProductionRequestOutcome>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<ProductionRequestOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (!sending) {
      setOpen(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      setSent(await onRequest({ title, note }));
      setOpen(false);
    } catch (failure) {
      setError(messageOf(failure, 'The request could not be sent.'));
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      {sent ? (
        <p className="text-content-secondary" role="status">
          {(admin ? ADMIN_SENT_MESSAGES : SENT_MESSAGES)[sent]}
        </p>
      ) : null}
      <Button size="sm" variant="neutral" onClick={() => setOpen(true)}>
        {sent ? 'Update request' : 'Request production'}
      </Button>
      {open ? (
        <Modal
          title="Request production"
          description={
            admin
              ? sent
                ? 'Your request waiting in Settings is replaced with this version, unless approving it has started.'
                : 'Make this app a real project: its own GitHub repository, deployed by its own pipeline. You approve it in Settings.'
              : sent
                ? 'Your request waiting for review is replaced with this version, unless an admin has started approving it.'
                : 'Your admins can make this app a real project: its own GitHub repository, deployed by its own pipeline.'
          }
          onClose={close}
        >
          <form className="grid gap-2 text-sm" onSubmit={(event) => void submit(event)}>
            <TextInput
              required
              maxLength={80}
              placeholder="App name"
              aria-label="App name"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <TextInput
              maxLength={1000}
              placeholder="What it's for (optional)"
              aria-label={admin ? 'Note' : 'Note for your admins'}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            {error ? (
              <p className="text-bolt-elements-icon-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="neutral" disabled={sending} onClick={close}>
                Cancel
              </Button>
              <Button size="sm" type="submit" loading={sending}>
                {sent ? 'Send this version' : admin ? 'Add request' : 'Send for review'}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
