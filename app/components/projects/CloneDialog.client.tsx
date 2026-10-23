import { useEffect, useState } from 'react';
import { format, isSameDay } from 'date-fns';
import { CheckIcon, CopyIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import type { ProjectCloneAccess } from '~/lib/cloudflare/data-api';
import { loadCloneAccess, type ProjectRef } from '~/lib/cloudflare/projects.client';
import { messageOf } from '~/lib/json-request';

/** The command that clones a project's repository, with a read token that expires soon after. */
export function CloneDialog({ project, name, onClose }: { project: ProjectRef; name: string; onClose: () => void }) {
  const [access, setAccess] = useState<ProjectCloneAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = 'chatInitialId' in project ? project.chatInitialId : project.orgProjectId;

  useEffect(() => {
    let cancelled = false;
    setAccess(null);
    setError(null);
    loadCloneAccess(project)
      .then((loaded) => {
        if (!cancelled) {
          setAccess(loaded);
          setNow(Date.now());
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(messageOf(cause, 'The clone command could not be made.'));
        }
      });
    return () => {
      cancelled = true;
    };
    // `project` is a fresh object each render; what it names is `ref`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, attempt]);

  // Says so once the token has expired, rather than offering a command that no longer works.
  useEffect(() => {
    if (!access) {
      return undefined;
    }
    const wait = access.expiresAt - Date.now();
    if (wait <= 0) {
      return undefined;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(wait + 1_000, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [access]);

  const copy = async () => {
    if (!access) {
      return;
    }
    try {
      await navigator.clipboard.writeText(access.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError('The command could not be copied. Select it and copy it instead.');
    }
  };

  const expired = access !== null && access.expiresAt <= now;
  const until = access
    ? isSameDay(access.expiresAt, now)
      ? format(access.expiresAt, 'p')
      : format(access.expiresAt, 'PPp')
    : '';

  return (
    <Modal onClose={onClose} title="Clone" description={name}>
      {error !== null ? (
        <div role="alert" className="mb-3 grid gap-2 text-sm text-content-secondary">
          <p>{error}</p>
          {access === null ? (
            <Button className="justify-self-start" size="xs" variant="neutral" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
      {access === null ? (
        error === null ? (
          <p className="text-sm text-content-tertiary" role="status">
            Making a clone command…
          </p>
        ) : null
      ) : expired ? (
        <div className="grid gap-2 text-sm text-content-secondary">
          <p>This command has expired.</p>
          <Button className="justify-self-start" size="xs" variant="neutral" onClick={() => setAttempt((n) => n + 1)}>
            Get a new command
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 text-sm">
          <p className="text-content-secondary">Run this in a terminal to clone the project with its full history.</p>
          <div className="flex min-w-0 items-start gap-2">
            <code
              className="min-w-0 flex-1 select-all rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-2 font-mono text-xs text-content-primary [overflow-wrap:anywhere]"
              aria-label="Clone command"
            >
              {access.command}
            </code>
            <Button
              size="xs"
              variant="neutral"
              icon={copied ? <CheckIcon /> : <CopyIcon />}
              onClick={() => void copy()}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-content-secondary">Anyone with this command can download the code until {until}.</p>
        </div>
      )}
    </Modal>
  );
}
