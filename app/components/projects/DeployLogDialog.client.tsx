import { useEffect, useState } from 'react';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { loadProjectDeployLog } from '~/lib/cloudflare/projects.client';
import { messageOf } from '~/lib/json-request';

/** The last part of what happened while a team project was being published, for when it didn't publish. */
export function DeployLogDialog({
  orgProjectId,
  deploymentId,
  name,
  onClose,
}: {
  orgProjectId: string;
  deploymentId: string;
  name: string;
  onClose: () => void;
}) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLog(null);
    setError(null);
    loadProjectDeployLog(orgProjectId, deploymentId, controller.signal)
      .then(setLog)
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(messageOf(cause, 'What happened could not be loaded. Try again.'));
        }
      });
    return () => controller.abort();
  }, [orgProjectId, deploymentId, attempt]);

  return (
    <Modal onClose={onClose} title="What happened" description={name}>
      {error !== null ? (
        <div role="alert" className="grid gap-2 text-sm text-content-secondary">
          <p>{error}</p>
          <div>
            <Button size="xs" variant="neutral" onClick={() => setAttempt((count) => count + 1)}>
              Try again
            </Button>
          </div>
        </div>
      ) : log === null ? (
        <p className="text-sm text-content-tertiary" role="status">
          Loading…
        </p>
      ) : (
        <pre
          aria-label="What happened"
          className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 font-mono text-xs text-content-primary"
        >
          {log.trim() || 'Nothing was written down for this one.'}
        </pre>
      )}
    </Modal>
  );
}
