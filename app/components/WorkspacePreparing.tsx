import { Button } from '@ui/Button';
import { Spinner } from '@ui/Spinner';

/** Said wherever the browser is waiting on provisioning, so the wait always reads the same. */
export const WORKSPACE_PREPARING_MESSAGE = 'Preparing your Cloudflare workspace. This takes a few minutes.';

/**
 * Provisioning a workspace is expected, slow, and self-resolving, so this states what is
 * happening instead of reporting a fault, and offers to keep waiting instead of a retry that
 * would only restart the same wait.
 */
export function WorkspacePreparingPanel({ onKeepWaiting }: { onKeepWaiting: () => void }) {
  return (
    <section
      className="app-card m-auto w-full max-w-lg shrink-0 p-5 text-center"
      aria-labelledby="workspace-preparing-heading"
      role="status"
    >
      <div className="app-loading-mark mx-auto" aria-hidden>
        <Spinner />
      </div>
      <h1 id="workspace-preparing-heading" className="mt-3 font-display text-xl font-bold text-content-primary">
        Preparing your workspace
      </h1>
      <p className="mx-auto mt-2 max-w-md text-balance text-sm text-content-secondary">
        Setup in your Cloudflare account takes a few minutes. You can leave this page and return later.
      </p>
      <Button className="mt-4" onClick={onKeepWaiting}>
        Keep waiting
      </Button>
    </section>
  );
}
