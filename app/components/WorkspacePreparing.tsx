import { useStore } from '@nanostores/react';
import { Button } from '@ui/Button';
import { Spinner } from '@ui/Spinner';
import { Loading } from '~/components/Loading';
import { userWorkspaceUpgradingStore } from '~/lib/cloudflare/runtime-session';

/** Said wherever the browser is waiting on provisioning, so the wait always reads the same. */
const WORKSPACE_PREPARING_MESSAGE = 'Preparing your Cloudflare workspace. This takes a few minutes.';

/** The wait after a CloudChef release changed the workspace: the existing one is being updated, briefly. */
const WORKSPACE_UPGRADING_MESSAGE =
  'Updating your Cloudflare workspace to the latest CloudChef. This takes a minute or two.';

export function workspacePreparingMessage(upgrading: boolean): string {
  return upgrading ? WORKSPACE_UPGRADING_MESSAGE : WORKSPACE_PREPARING_MESSAGE;
}

/** The full-page wait while the workspace is set up or updated, saying which. */
export function WorkspacePreparingLoading() {
  const upgrading = useStore(userWorkspaceUpgradingStore);
  return <Loading message={workspacePreparingMessage(upgrading)} />;
}

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
