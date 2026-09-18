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
      className="app-card w-full max-w-lg p-6 text-center sm:p-8"
      aria-labelledby="workspace-preparing-heading"
      role="status"
    >
      <div className="app-loading-mark mx-auto" aria-hidden>
        <Spinner />
      </div>
      <p className="app-page-eyebrow mt-4">Workspace preparing</p>
      <h1 id="workspace-preparing-heading" className="mt-2 font-display text-3xl font-black text-content-primary">
        CloudChef is still preparing your workspace.
      </h1>
      <p className="mx-auto mt-4 max-w-md text-balance text-sm text-content-secondary">
        CloudChef is building this workspace inside your Cloudflare account. That takes a few minutes and finishes on
        its own — nothing has gone wrong, and there is nothing to fix.
      </p>
      <Button className="mt-6" onClick={onKeepWaiting}>
        Keep waiting
      </Button>
    </section>
  );
}
