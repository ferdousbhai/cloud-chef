import { useEffect, useState, type FormEvent } from 'react';
import type { BuilderDeploymentState } from '~/agents/builder-deployment-command';
import { publicationStageLabel, type BuilderPublicationState } from '~/agents/builder-publication-progress';
import { Button } from '~/components/ui/primitives/Button';
import { captureProductEvent } from '~/lib/telemetry.client';
import { TextInput } from '@ui/TextInput';
import { authClient } from '~/lib/auth-client';

export function DeploymentStatus({
  deployment,
  publication,
  onRetry,
  onRequestProduction,
}: {
  deployment: BuilderDeploymentState;
  publication?: BuilderPublicationState | null;
  onRetry?: () => Promise<BuilderDeploymentState>;
  onRequestProduction?: (input: { title: string; note: string }) => Promise<void>;
}) {
  const { data: session } = authClient.useSession();
  // In an organization's account, a deployed draft can be sent to its admins to become a real project.
  const inOrganization = session?.context?.kind === 'organization';
  const stage = publication?.lane === 'deployment' ? publicationStageLabel(publication) : null;
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
      {deployment.status === 'succeeded' && inOrganization && onRequestProduction ? (
        <RequestProduction onRequest={onRequestProduction} />
      ) : null}
      {deployment.status === 'succeeded' ? null : deployment.status === 'failed' ? (
        <>
          <h3 className="text-content-primary font-medium">Deployment failed</h3>
          {deployment.error ? <p className="text-bolt-elements-icon-error">{deployment.error}</p> : null}
          {onRetry ? (
            <Button size="sm" onClick={() => void onRetry()}>
              Try again
            </Button>
          ) : null}
        </>
      ) : (
        <p className="text-content-secondary" role="status" aria-live="polite">
          {stage ?? 'Deploying…'}
        </p>
      )}
    </section>
  );
}

/** Sends a deployed draft to the organization's admins, who can make it a real project on GitHub. */
function RequestProduction({ onRequest }: { onRequest: (input: { title: string; note: string }) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (state === 'sent') {
    return <p className="text-content-secondary">Sent to your organization&apos;s admins for review.</p>;
  }
  if (!open) {
    return (
      <Button size="sm" variant="neutral" onClick={() => setOpen(true)}>
        Request production
      </Button>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState('sending');
    setError(null);
    try {
      await onRequest({ title, note });
      setState('sent');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request could not be sent.');
      setState('idle');
    }
  };
  return (
    <form className="grid gap-1.5" onSubmit={(event) => void submit(event)}>
      <p className="text-content-secondary">
        Your admins can make this app a real project: its own GitHub repository, deployed by its own pipeline.
      </p>
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
        aria-label="Note for your admins"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {error ? <p className="text-bolt-elements-icon-error">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" type="submit" loading={state === 'sending'}>
          Send for review
        </Button>
        <Button size="sm" variant="neutral" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
