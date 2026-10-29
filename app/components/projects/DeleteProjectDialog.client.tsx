import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { Spinner } from '@ui/Spinner';
import { TextInput } from '@ui/TextInput';
import type { ProjectDeletionPreview } from '~/lib/cloudflare/org-projects.client';
import { messageOf } from '~/lib/json-request';

/**
 * Deletes a project for good, after saying what goes with it and having the person type its name. With `preview`,
 * the dialog first lists exactly what deleting it removes from the Cloudflare account, and what it keeps because
 * something else uses it.
 */
export function DeleteProjectDialog({
  name,
  preview,
  summary,
  onDelete,
  onDeleted,
  onClose,
}: {
  name: string;
  preview?: () => Promise<ProjectDeletionPreview>;
  /** What deleting removes, in words, when there is no `preview` to list it. */
  summary?: ReactNode;
  /** Deletes it; throws with what went wrong. */
  onDelete: () => Promise<void>;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [listed, setListed] = useState<ProjectDeletionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read once per try: the parent may render again (its list refreshes) with a new function for the same project.
  const previewRef = useRef(preview);
  useEffect(() => {
    const read = previewRef.current;
    if (!read) {
      return undefined;
    }
    let current = true;
    setPreviewError(null);
    read()
      .then((answer) => current && setListed(answer))
      .catch(
        (cause) => current && setPreviewError(messageOf(cause, 'What it would delete couldn’t be read. Try again.')),
      );
    return () => {
      current = false;
    };
  }, [attempt]);

  const ready = !preview || listed !== null;
  const matches = typed === name;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches || !ready) {
      return;
    }
    setError(null);
    setDeleting(true);
    try {
      await onDelete();
      onDeleted();
    } catch (cause) {
      setError(messageOf(cause, `${name} couldn’t be deleted. Try again.`));
      setDeleting(false);
    }
  };

  return (
    <Modal onClose={deleting ? undefined : onClose} title={`Delete ${name}?`}>
      <form className="grid gap-3 text-sm" onSubmit={(event) => void submit(event)}>
        <p className="font-medium text-content-error">
          This deletes the project’s code, its site and its data for good. It can’t be undone.
        </p>
        {preview ? (
          previewError !== null ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-content-secondary">
              <span>{previewError}</span>
              <Button size="xs" variant="neutral" onClick={() => setAttempt((count) => count + 1)}>
                Try again
              </Button>
            </div>
          ) : listed === null ? (
            <p role="status" className="flex items-center gap-2 text-content-secondary">
              <Spinner /> Checking what goes with it…
            </p>
          ) : (
            <PreviewList preview={listed} />
          )
        ) : (
          summary
        )}
        <label className="grid gap-1">
          <span className="text-content-primary">
            Type <strong className="font-mono">{name}</strong> to confirm
          </span>
          <TextInput
            autoComplete="off"
            spellCheck={false}
            value={typed}
            disabled={deleting}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        {error !== null ? (
          <p role="alert" className="text-bolt-elements-icon-error wrap-anywhere">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="neutral" disabled={deleting} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!matches || !ready || deleting} loading={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PreviewList({ preview }: { preview: ProjectDeletionPreview }) {
  const removed = [
    ...preview.sites.map((site) => `Site ${site}`),
    ...(preview.buildTriggers.length > 0 ? ['Its automatic builds from its code'] : []),
    ...preview.workers.map((worker) => `Worker ${worker}, with its versions and previews`),
    ...preview.resources.map(resourceLabel),
    ...(preview.repository ? ['Its code, with every version'] : []),
  ];
  return (
    <div className="grid gap-2 text-content-secondary">
      <div>
        <p className="text-content-primary">Deleted from the Cloudflare account:</p>
        <ul className="ml-4 list-disc wrap-anywhere">
          {removed.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      {preview.kept.length > 0 ? (
        <div>
          <p className="text-content-primary">Kept:</p>
          <ul className="ml-4 list-disc wrap-anywhere">
            {preview.kept.map((resource) => (
              <li key={`${resource.kind}:${resource.id}`}>
                {resourceLabel(resource)}: {resource.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function resourceLabel(resource: ProjectDeletionPreview['resources'][number]): string {
  const kind =
    resource.kind === 'database'
      ? 'Database'
      : resource.kind === 'storage'
        ? 'File storage'
        : resource.kind === 'keys'
          ? 'Key-value store'
          : 'Resource';
  return `${kind} ${resource.name}`;
}

/**
 * What deleting one of the person's own apps does. The grace period is `AGENT_GC_GRACE_PERIOD_MS`, after which the
 * sweeps delete its Cloudflare resources, its repository and its workspace. A team project's workspace is never
 * listed here; a team project is deleted from its card.
 */
export function AppDeletionNotice() {
  return (
    <p className="text-content-secondary">
      It leaves your projects now. After a 30-minute grace period, its live site, databases, stored files, code and
      workspace are deleted for good. Provider-retained logs and browser data are not erased. See the{' '}
      <Link to="/privacy">Privacy notice</Link>.
    </p>
  );
}
