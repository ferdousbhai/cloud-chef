import { useState, type FormEvent } from 'react';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { Spinner } from '@ui/Spinner';
import { TextInput } from '@ui/TextInput';
import { authClient } from '~/lib/auth-client';
import { copyProject } from '~/lib/cloudflare/org-projects.client';
import { messageOf } from '~/lib/json-request';

/**
 * Makes a copy of a project, with all its history, in the account the person is working in now (theirs, or
 * the team's), and opens it. Copying takes a while, so the dialog stays open, saying so, until it is done.
 */
export function CopyProjectDialog({
  project,
  onOpenProject,
  onClose,
}: {
  project: { id: string; name: string };
  /** Opens the copy's chat. */
  onOpenProject: (initialId: string) => void;
  onClose: () => void;
}) {
  const context = authClient.useSession().data?.context ?? null;
  const account = context?.kind === 'organization' ? context.orgName : 'Personal';
  const [name, setName] = useState(project.name);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setCopying(true);
    try {
      const copy = await copyProject(project.id, name.trim() || project.name);
      onOpenProject(copy.initialId);
    } catch (cause) {
      setError(messageOf(cause, 'The copy could not be made. Try again.'));
      setCopying(false);
    }
  };

  if (copying) {
    return (
      <Modal title="Make a copy">
        <div className="grid gap-2 text-sm text-content-secondary" role="status">
          <p className="flex items-center gap-2 font-medium text-content-primary">
            <Spinner /> Making your copy…
          </p>
          <p>CloudChef copies every version of {project.name}, which can take a minute. Keep this page open.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} title="Make a copy" description={project.name}>
      <form className="grid gap-3 text-sm" onSubmit={(event) => void submit(event)}>
        <label className="grid gap-1">
          <span className="font-medium text-content-primary">Name of your copy</span>
          <TextInput required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <p className="text-content-secondary">
          The copy goes into <span className="font-medium text-content-primary">{account}</span>, the account you’re
          working in now, with all of its history. It’s yours to change and publish; the original stays as it is.
        </p>
        {error !== null ? (
          <p role="alert" className="text-sm text-bolt-elements-icon-error [overflow-wrap:anywhere]">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="neutral" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={name.trim() === ''}>
            Make a copy
          </Button>
        </div>
      </form>
    </Modal>
  );
}
