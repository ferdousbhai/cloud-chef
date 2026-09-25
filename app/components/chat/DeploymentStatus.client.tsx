import { useEffect } from 'react';
import type { BuilderDeploymentState } from '~/agents/builder-deployment-command';
import { publicationStageLabel, type BuilderPublicationState } from '~/agents/builder-publication-progress';
import { Button } from '~/components/ui/primitives/Button';
import { captureProductEvent } from '~/lib/telemetry.client';

export function DeploymentStatus({
  deployment,
  publication,
  onRetry,
}: {
  deployment: BuilderDeploymentState;
  publication?: BuilderPublicationState | null;
  onRetry?: () => Promise<BuilderDeploymentState>;
}) {
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
      ) : deployment.status === 'failed' ? (
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
