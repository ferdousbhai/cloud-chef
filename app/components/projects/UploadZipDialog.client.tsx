import { useState, type FormEvent } from 'react';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { Spinner } from '@ui/Spinner';
import { TextInput } from '@ui/TextInput';
import { uploadProject } from '~/lib/cloudflare/projects.client';
import { messageOf } from '~/lib/json-request';

/** What a ZIP may be: a project's files may add up to 64 MB in a workspace (`BUILDER_WORKSPACE_MAX_TOTAL_BYTES`). */
const MAX_ZIP_BYTES = 64 * 1024 * 1024;

/**
 * Makes a new project, in the account the person is working in (theirs, or the team's), from a ZIP of its
 * code. Its files become the project's first version; when they are all in one folder, that folder's
 * contents do.
 */
export function UploadZipDialog({
  onOpenProject,
  onClose,
}: {
  /** Opens the new project. */
  onOpenProject: (initialId: string) => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestedName = file ? file.name.replace(/\.zip$/i, '') : '';
  const tooLarge = file !== null && file.size > MAX_ZIP_BYTES;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || tooLarge) {
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const result = await uploadProject(file, name.trim() || suggestedName || 'Uploaded project');
      onOpenProject(result.initialId);
    } catch (cause) {
      setError(messageOf(cause, 'The ZIP could not be uploaded. Try again.'));
      setUploading(false);
    }
  };

  if (uploading) {
    return (
      <Modal title="Upload a ZIP">
        <div className="grid gap-2 text-sm text-content-secondary" role="status">
          <p className="flex items-center gap-2 font-medium text-content-primary">
            <Spinner /> Uploading {file?.name}…
          </p>
          <p>CloudChef unpacks it and saves its files as your new project. Keep this page open.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} title="Upload a ZIP">
      <form className="grid gap-3 text-sm" onSubmit={(event) => void submit(event)}>
        <label className="grid gap-1">
          <span className="font-medium text-content-primary">ZIP of your project&apos;s code</span>
          <input
            required
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="text-content-secondary file:mr-3 file:rounded-md file:border file:border-bolt-elements-borderColor file:bg-bolt-elements-background-depth-2 file:px-3 file:py-1.5 file:text-sm file:text-content-primary"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError(null);
            }}
            aria-invalid={tooLarge}
          />
        </label>
        {tooLarge ? (
          <p className="text-xs text-bolt-elements-icon-error">
            This ZIP is larger than 64 MB. Leave out folders that can be made again, such as node_modules.
          </p>
        ) : null}
        <label className="grid gap-1">
          <span className="text-content-secondary">Project name (optional)</span>
          <TextInput
            maxLength={80}
            placeholder={suggestedName || 'Project name'}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 text-xs text-content-secondary">
          The files in the ZIP become the project&apos;s first version; if they are all inside one folder, the project
          starts from inside it. Only the files come along, not earlier versions of them. Up to 64 MB.
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
          <Button type="submit" disabled={file === null || tooLarge}>
            Upload
          </Button>
        </div>
      </form>
    </Modal>
  );
}
