import { Button } from '@ui/Button';
import type { WorkspaceFilesStatus } from '~/lib/stores/workbench.client';
import { WORKSPACE_MESSAGES } from '~/lib/workspace-messages';

/**
 * What the code view says while it has no files to show: that they are on their way, or why they are not
 * coming and what to do. Null once there is nothing to say, so the editor shows as it is.
 */
export function WorkspaceFilesNotice({ status, hasFiles }: { status: WorkspaceFilesStatus; hasFiles: boolean }) {
  if (hasFiles || status.state === 'ready') {
    return null;
  }
  if (status.state === 'connecting' || status.state === 'reconnecting') {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-bolt-elements-background-depth-2 p-6">
        <p className="text-center text-sm text-content-secondary" role="status">
          {status.state === 'connecting' ? WORKSPACE_MESSAGES.loading : WORKSPACE_MESSAGES.reconnecting}
        </p>
      </div>
    );
  }
  const { heading, detail, action } =
    status.state === 'failed'
      ? { heading: WORKSPACE_MESSAGES.failed, detail: status.failure, action: 'Try again' }
      : status.state === 'unavailable'
        ? {
            heading: WORKSPACE_MESSAGES.unavailable,
            detail: WORKSPACE_MESSAGES.unavailableDetail,
            action: 'Reconnect',
          }
        : {
            heading: WORKSPACE_MESSAGES.editorFailed,
            detail: WORKSPACE_MESSAGES.editorFailedDetail,
            action: 'Try again',
          };
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-y-auto bg-bolt-elements-background-depth-2 p-6">
      <section className="max-w-md text-center" aria-labelledby="workspace-files-heading">
        <h2 id="workspace-files-heading" className="text-base font-semibold text-content-primary">
          {heading}
        </h2>
        {detail ? (
          <p className="mt-2 break-words text-sm text-content-secondary" role="alert">
            {detail}
          </p>
        ) : null}
        {status.retry ? (
          <Button className="mt-4" variant="neutral" size="sm" onClick={status.retry}>
            {action}
          </Button>
        ) : null}
      </section>
    </div>
  );
}
