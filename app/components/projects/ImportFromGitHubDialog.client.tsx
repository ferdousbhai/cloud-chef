import { useEffect, useState, type FormEvent } from 'react';
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
  startGitHubAccountReuse,
  startGitHubAppInstall,
  type GitHubAccountToReuse,
  type GitHubRepository,
} from '~/lib/github-app.client';
import { messageOf, RequestError } from '~/lib/json-request';

type Step =
  | { kind: 'form' }
  | { kind: 'importing'; repository: string }
  | { kind: 'imported'; repository: string; result: ProjectImportResult };

/**
 * Imports a GitHub repository, with its full history, as a project in the account the person is working in
 * (theirs, or the team's). A public repository imports from its address; a private one needs CloudChef's
 * GitHub App (CloudChef Import) installed on its account first, or, when the App is already on the person's own
 * GitHub account from another of their accounts, GitHub's confirmation that it's them to connect it here too.
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
  // GitHub accounts the App is on whose repositories couldn't be listed just now.
  const [unreachable, setUnreachable] = useState<string[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  // The person's own GitHub account, which has the App, connected elsewhere (Personal, or a team) and not here.
  const [reusable, setReusable] = useState<GitHubAccountToReuse[]>([]);
  const [reusing, setReusing] = useState<number | null>(null);
  const repository = gitHubRepositoryName(address);
  const reusableLogins = reusable.map((account) => account.accountLogin).join(', ');

  useEffect(() => {
    const controller = new AbortController();
    listGitHubRepositories(orgId, controller.signal)
      .then(({ repositories, unreachable, reusable }) => {
        setInstalled(repositories);
        setUnreachable(unreachable);
        setReusable(reusable);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) {
          // "Not available" (409) means installing the App; anything else is GitHub failing just now.
          if (!(cause instanceof RequestError && cause.status === 409)) {
            setListError(messageOf(cause, 'GitHub could not be reached just now. Try again in a moment.'));
          }
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

  // The App is on this GitHub account already: GitHub only confirms it's them, then it's connected here too.
  const reuse = async (installationId: number) => {
    setReusing(installationId);
    try {
      await startGitHubAccountReuse(orgId, installationId, importReturnURL(window.location.href));
    } catch (cause) {
      setError(messageOf(cause, 'GitHub could not be reached. Try again.'));
      setReusing(null);
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
        {listError !== null ? (
          <p className="text-xs text-content-secondary" role="status">
            {listError} Public repositories still import from their address.
          </p>
        ) : null}
        {unreachable.length > 0 ? (
          <p className="text-xs text-content-secondary" role="status">
            GitHub couldn&apos;t list the repositories of {unreachable.join(', ')} just now, so they aren&apos;t below.
            Try again in a moment.
          </p>
        ) : null}
        {installed !== null && installed.length > 0 ? (
          <label className="grid gap-1">
            <span className="text-content-secondary">Or choose a repository CloudChef Import can read</span>
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
                Public repositories import from their address. For a private repository, install CloudChef Import,
                CloudChef&apos;s GitHub App, on the account that holds it and give it that repository; it can be
                installed on several accounts. It only reads, and only for the import.
              </p>
              {reusable.length > 0 ? (
                <>
                  <p>
                    The App is already on your GitHub account ({reusableLogins}). CloudChef will ask GitHub to confirm
                    it&apos;s you, then you can import from it here too.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {reusable.map((account) => (
                      <Button
                        key={account.installationId}
                        size="xs"
                        loading={reusing === account.installationId}
                        disabled={installing || (reusing !== null && reusing !== account.installationId)}
                        onClick={() => void reuse(account.installationId)}
                      >
                        {reusable.length > 1 ? `Use ${account.accountLogin} here` : 'Use my GitHub account here'}
                      </Button>
                    ))}
                    <Button
                      size="xs"
                      variant="neutral"
                      loading={installing}
                      disabled={reusing !== null}
                      onClick={() => void install()}
                    >
                      Add a different GitHub account
                    </Button>
                  </div>
                </>
              ) : (
                <Button
                  className="justify-self-start"
                  size="xs"
                  variant="neutral"
                  loading={installing}
                  onClick={() => void install()}
                >
                  {installed.length > 0 || unreachable.length > 0 || listError !== null
                    ? 'Add GitHub accounts or repositories'
                    : 'Install CloudChef Import on GitHub'}
                </Button>
              )}
            </div>
          )}
        </div>
        {error !== null ? (
          <p role="alert" className="text-sm text-bolt-elements-icon-error wrap-anywhere">
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

/**
 * After an import whose repository a Worker in the account is still built from by Workers Builds: CloudChef publishes
 * the project itself, and only the person can disconnect that repository from the Worker.
 */
function ImportedProject({
  repository,
  onOpen,
  onClose,
}: {
  repository: string;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} title="Imported">
      <div className="grid gap-3 text-sm text-content-secondary">
        <p>{repository} is now a CloudChef project, with its history.</p>
        <p>
          Its site still goes live from GitHub too. To publish it only from CloudChef, open its Worker in the Cloudflare
          dashboard, then Settings, then Builds, and disconnect the repository.{' '}
          <a
            className="underline"
            href="https://dash.cloudflare.com/?to=/:account/workers-and-pages"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the Cloudflare dashboard
          </a>
        </p>
        <div className="flex justify-end">
          <Button onClick={onOpen}>Open project</Button>
        </div>
      </div>
    </Modal>
  );
}
