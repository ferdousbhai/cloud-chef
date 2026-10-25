import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { Spinner } from '@ui/Spinner';
import { TextInput } from '@ui/TextInput';
import type { ProjectImportResult } from '~/lib/cloudflare/data-api';
import { importProject } from '~/lib/cloudflare/projects.client';
import {
  gitHubRepositoryName,
  importReturnURL,
  listGitHubRepositories,
  startGitHubAppInstall,
  type GitHubRepository,
} from '~/lib/github-app.client';
import { messageOf, postJson } from '~/lib/json-request';

/** What switching a project's Workers Builds to its Artifacts repository answered. */
const switchedSchema = z.union([
  z.object({ switched: z.literal(true) }),
  // Cloudflare's API can't always make the change; the dashboard can, and the answer says how.
  z.object({ instruction: z.string(), url: z.url({ protocol: /^https$/ }).optional() }),
]);

type Step =
  | { kind: 'form' }
  | { kind: 'importing'; repository: string }
  | { kind: 'imported'; repository: string; result: ProjectImportResult };

/**
 * Imports a GitHub repository, with its full history, as a project in the account the person is working in
 * (theirs, or the team's). A public repository imports from its address; a private one needs CloudChef's
 * GitHub App installed on its account first.
 */
export function ImportFromGitHubDialog({
  orgId,
  onOpenProject,
  onClose,
}: {
  orgId: string | null;
  /** Opens the imported project. */
  onOpenProject: (initialId: string) => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  // Null until known; an empty list once the App is known not to reach anything here.
  const [installed, setInstalled] = useState<GitHubRepository[] | null>(null);
  const [installing, setInstalling] = useState(false);
  const repository = gitHubRepositoryName(address);

  useEffect(() => {
    const controller = new AbortController();
    listGitHubRepositories(orgId, controller.signal)
      .then(setInstalled)
      .catch(() => {
        if (!controller.signal.aborted) {
          setInstalled([]);
        }
      });
    return () => controller.abort();
  }, [orgId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!repository) {
      return;
    }
    setError(null);
    setStep({ kind: 'importing', repository });
    try {
      const result = await importProject({
        url: `https://github.com/${repository}`,
        name: name.trim() || undefined,
      });
      if (result.workersBuildsFromGitHub) {
        setStep({ kind: 'imported', repository, result });
      } else {
        onOpenProject(result.initialId);
      }
    } catch (cause) {
      setError(messageOf(cause, 'The repository could not be imported. Try again.'));
      setStep({ kind: 'form' });
    }
  };

  const install = async () => {
    setInstalling(true);
    try {
      await startGitHubAppInstall(orgId, importReturnURL(window.location.href));
    } catch (cause) {
      setError(messageOf(cause, 'GitHub could not be reached. Try again.'));
      setInstalling(false);
    }
  };

  if (step.kind === 'importing') {
    return (
      <Modal title="Import from GitHub">
        <div className="grid gap-2 text-sm text-content-secondary" role="status">
          <p className="flex items-center gap-2 font-medium text-content-primary">
            <Spinner /> Importing {step.repository}…
          </p>
          <p>
            CloudChef copies the repository with its full history. A large one can take a few minutes; keep this page
            open.
          </p>
        </div>
      </Modal>
    );
  }

  if (step.kind === 'imported') {
    return (
      <ImportedProject
        repository={step.repository}
        result={step.result}
        onOpen={() => onOpenProject(step.result.initialId)}
        onClose={onClose}
      />
    );
  }

  return (
    <Modal onClose={onClose} title="Import from GitHub">
      <form className="grid gap-3 text-sm" onSubmit={(event) => void submit(event)}>
        <label className="grid gap-1">
          <span className="font-medium text-content-primary">Repository address</span>
          <TextInput
            required
            inputMode="url"
            autoComplete="off"
            placeholder="https://github.com/owner/repository"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            aria-invalid={address.trim() !== '' && repository === null}
          />
        </label>
        {address.trim() !== '' && repository === null ? (
          <p className="text-xs text-bolt-elements-icon-error">Paste a github.com repository address.</p>
        ) : null}
        {installed !== null && installed.length > 0 ? (
          <label className="grid gap-1">
            <span className="text-content-secondary">Or choose a repository the CloudChef GitHub App can read</span>
            <select
              value={installed.find((candidate) => candidate.fullName === repository)?.fullName ?? ''}
              onChange={(event) => setAddress(event.target.value ? `https://github.com/${event.target.value}` : '')}
              className="min-h-9 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 text-sm text-content-primary"
            >
              <option value="">Choose a repository</option>
              {installed.map((candidate) => (
                <option key={candidate.id} value={candidate.fullName}>
                  {candidate.fullName}
                  {candidate.private ? ' (private)' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="grid gap-1">
          <span className="text-content-secondary">Project name (optional)</span>
          <TextInput
            maxLength={80}
            placeholder={repository?.split('/')[1] ?? 'Project name'}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 text-xs text-content-secondary">
          {installed === null ? (
            <p role="status">Checking which repositories CloudChef can read…</p>
          ) : (
            <div className="grid gap-2">
              <p>
                Public repositories import from their address. For a private repository, install the CloudChef GitHub
                App on the account that holds it and give it that repository; it can be installed on several accounts.
                It only reads, and only for the import.
              </p>
              <Button
                className="justify-self-start"
                size="xs"
                variant="neutral"
                loading={installing}
                onClick={() => void install()}
              >
                {installed.length > 0 ? 'Add an account or repositories on GitHub' : 'Install the CloudChef GitHub App'}
              </Button>
            </div>
          )}
        </div>
        {error !== null ? (
          <p role="alert" className="text-sm text-bolt-elements-icon-error [overflow-wrap:anywhere]">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="neutral" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={repository === null}>
            Import
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** After an import whose repository Workers Builds deploys from GitHub: offer to build it from Artifacts. */
function ImportedProject({
  repository,
  result,
  onOpen,
  onClose,
}: {
  repository: string;
  result: ProjectImportResult;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [switching, setSwitching] = useState(false);
  const [answer, setAnswer] = useState<z.infer<typeof switchedSchema> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const switchBuilds = async () => {
    setSwitching(true);
    setError(null);
    try {
      setAnswer(
        await postJson(
          `/api/projects/${encodeURIComponent(result.projectId)}/workers-builds/switch`,
          {},
          switchedSchema,
        ),
      );
    } catch (cause) {
      setError(messageOf(cause, "That couldn't be changed. Try again."));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Imported">
      <div className="grid gap-3 text-sm text-content-secondary">
        <p>{repository} is now a CloudChef project, with its history.</p>
        {answer === null ? (
          <>
            <p>
              This site still goes live from GitHub. Switch it to go live from CloudChef, so the changes you publish
              here reach it.
            </p>
            <Button
              className="justify-self-start"
              size="sm"
              variant="neutral"
              loading={switching}
              onClick={() => void switchBuilds()}
            >
              Go live from CloudChef
            </Button>
          </>
        ) : 'switched' in answer ? (
          <p role="status">This site now goes live from CloudChef.</p>
        ) : (
          <p role="status" className="[overflow-wrap:anywhere]">
            {answer.instruction}{' '}
            {answer.url ? (
              <a className="underline" href={answer.url} target="_blank" rel="noopener noreferrer">
                Open the Cloudflare dashboard
              </a>
            ) : null}
          </p>
        )}
        {error !== null ? (
          <p role="alert" className="text-bolt-elements-icon-error [overflow-wrap:anywhere]">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button onClick={onOpen}>Open project</Button>
        </div>
      </div>
    </Modal>
  );
}
