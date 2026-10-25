import { Button } from '@ui/Button';
import type { WorkspaceFilesStatus } from '~/lib/stores/workbench.client';

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
          {status.state === 'connecting' ? 'Loading project files…' : 'Reconnecting to your workspace…'}
        </p>
      </div>
    );
  }
  const { heading, detail, action } =
    status.state === 'failed'
      ? { heading: 'CloudChef could not open this project.', detail: status.failure, action: 'Try again' }
      : status.state === 'unavailable'
        ? {
            heading: 'CloudChef could not reach your workspace.',
            detail: 'Chat is paused until it reconnects.',
            action: 'Reconnect',
          }
        : {
            heading: "The editor could not load this project's files.",
            detail: 'Chat, builds, and previews still work.',
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
