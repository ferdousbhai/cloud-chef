import { useEffect, useState } from 'react';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { loadProjectDeployLog } from '~/lib/cloudflare/projects.client';
import { messageOf } from '~/lib/json-request';

/** How often a publish still running is asked for its log again. */
const LIVE_REFRESH_MS = 3_000;

/**
 * The last part of what happened while a project was being published: as it happens while it runs (`live`),
 * or after, for when it didn't publish.
 */
export function DeployLogDialog({
  orgProjectId,
  deploymentId,
  name,
  live = false,
  onClose,
}: {
  orgProjectId: string;
  deploymentId: string;
  name: string;
  live?: boolean;
  onClose: () => void;
}) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const load = () =>
      loadProjectDeployLog(orgProjectId, deploymentId, controller.signal)
        .then((text) => {
          setLog(text);
          setError(null);
        })
        .catch((cause) => {
          // While it runs, a log not started yet is just not there yet.
          if (!controller.signal.aborted && !live) {
            setError(messageOf(cause, 'What happened could not be loaded. Try again.'));
          }
        })
        .finally(() => {
          if (live && !controller.signal.aborted) {
            timer = window.setTimeout(() => void load(), LIVE_REFRESH_MS);
          }
        });
    setLog(null);
    setError(null);
    void load();
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [orgProjectId, deploymentId, attempt, live]);

  return (
    <Modal onClose={onClose} title={live ? 'Progress' : 'What happened'} description={name}>
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
          {live ? 'Starting…' : 'Loading…'}
        </p>
      ) : (
        <pre
          aria-label="What happened"
          className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 font-mono text-xs text-content-primary"
        >
          {withoutTerminalColors(log).trim() || 'Nothing was written down for this one.'}
        </pre>
      )}
    </Modal>
  );
}

/** The color and cursor codes tools write for a terminal: an escape character, `[`, numbers, a letter. */
const TERMINAL_CODES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

/** The log as text, without the codes tools write for a terminal. */
function withoutTerminalColors(log: string): string {
  return log.replace(TERMINAL_CODES, '');
}
