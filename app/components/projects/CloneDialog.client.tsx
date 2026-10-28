import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { loadGitProjectId, type ProjectRef } from '~/lib/cloudflare/projects.client';
import { messageOf } from '~/lib/json-request';

/**
 * How to clone a project: through CloudChef's own git address, which checks the person's access on every request,
 * with the `cloudchef` command or plain git. `fullName` (`owner/name`) names it when it has one; its id otherwise.
 */
export function CloneDialog({
  project,
  name,
  fullName = null,
  onClose,
}: {
  project: ProjectRef;
  name: string;
  fullName?: string | null;
  onClose: () => void;
}) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ref = 'chatInitialId' in project ? project.chatInitialId : project.orgProjectId;

  useEffect(() => {
    let cancelled = false;
    setProjectId(null);
    setError(null);
    loadGitProjectId(project)
      .then((loaded) => {
        if (!cancelled) {
          setProjectId(loaded);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(messageOf(cause, 'Its address could not be found.'));
        }
      });
    return () => {
      cancelled = true;
    };
    // `project` is a fresh object each render; what it names is `ref`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, attempt]);

  const origin = window.location.origin;
  const gitUrl = fullName ? `${origin}/${fullName}.git` : `${origin}/git/${projectId}.git`;

  return (
    <Modal onClose={onClose} title="Clone" description={name}>
      {error !== null ? (
        <div role="alert" className="grid gap-2 text-sm text-content-secondary">
          <p>{error}</p>
          <Button className="justify-self-start" size="xs" variant="neutral" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : projectId === null ? (
        <p className="text-sm text-content-tertiary" role="status">
          Finding its address…
        </p>
      ) : (
        <div className="grid gap-4 text-sm">
          <p className="text-content-secondary">Get the code, with its whole history, on your own computer.</p>
          <div className="grid gap-2">
            <p className="font-medium text-content-primary">With the cloudchef command</p>
            <CopyableCommand label="cloudchef command" command={`cloudchef repo clone ${fullName ?? projectId}`} />
            <p className="text-content-secondary">
              Install it once with <code className="font-mono text-xs">curl -fsSL {origin}/install.sh | bash</code>,
              then sign in with <code className="font-mono text-xs">cloudchef auth login</code>.
            </p>
          </div>
          <div className="grid gap-2 border-t border-bolt-elements-borderColor pt-3">
            <p className="font-medium text-content-primary">With git</p>
            <CopyableCommand label="git command" command={`git clone ${gitUrl}`} />
            <p className="text-content-secondary">
              When git asks for a password, use a command-line token from{' '}
              <a className="underline" href="/settings#command-line">
                Settings
              </a>
              . If you can edit the project, pushing main publishes it.
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** A command to run, with a button that copies it. */
function CopyableCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setFailed(true);
    }
  };
  return (
    <>
      <div className="flex min-w-0 items-start gap-2">
        <code
          className="min-w-0 flex-1 select-all rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-2 font-mono text-xs text-content-primary [overflow-wrap:anywhere]"
          aria-label={label}
        >
          {command}
        </code>
        <Button
          size="xs"
          variant="neutral"
          icon={copied ? <CheckIcon /> : <CopyIcon />}
          aria-label={`${copied ? 'Copied' : 'Copy'} the ${label.toLowerCase()}`}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="text-xs text-content-secondary">
          It could not be copied. Select it and copy it instead.
        </p>
      ) : null}
    </>
  );
}
