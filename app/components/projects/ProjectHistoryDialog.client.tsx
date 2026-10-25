import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { toast } from 'sonner';
import { Button } from '@ui/Button';
import { ConfirmationDialog } from '@ui/ConfirmationDialog';
import { Modal } from '@ui/Modal';
import type { ProjectCommit } from '~/lib/cloudflare/data-api';
import {
  commitTitle,
  downloadProjectArchive,
  forkProject,
  HISTORY_PAGE_SIZE,
  loadProjectHistory,
  shortCommit,
  type ProjectRef,
} from '~/lib/cloudflare/projects.client';
import { leavePage } from '~/lib/hooks/useUnsavedEditsGuard';
import { messageOf } from '~/lib/json-request';
import { projectRevertStore } from '~/lib/stores/project-actions.client';

/**
 * A project's commits, newest first, with what can be done from each: revert the open workspace to it, fork
 * a new project from it, or download its files.
 */
export function ProjectHistoryDialog({
  project,
  name,
  canRevert,
  canFork,
  onOpenProject,
  onClose,
}: {
  project: ProjectRef;
  /** The project's name, for the dialog and the ZIP's file name. */
  name: string;
  /** Whether this person may change the project: their own, or a team project they can edit. */
  canRevert: boolean;
  /** Forking makes a new project of the person's own, from one of their own. */
  canFork: boolean;
  /** Opens a project made here, such as a fork. */
  onOpenProject: (initialId: string) => void;
  onClose: () => void;
}) {
  const [commits, setCommits] = useState<ProjectCommit[] | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<{ hash: string; action: 'revert' | 'fork' | 'download' } | null>(null);
  const [confirmingRevert, setConfirmingRevert] = useState<ProjectCommit | null>(null);
  // Reverting goes through the open chat's builder agent; a project not open here has none.
  const revert = useStore(projectRevertStore);
  const ref = 'chatInitialId' in project ? project.chatInitialId : project.orgProjectId;

  useEffect(() => {
    const controller = new AbortController();
    setCommits(null);
    setLoadError(null);
    loadProjectHistory(project, 0, controller.signal)
      .then((page) => {
        setCommits(page);
        setHasOlder(page.length === HISTORY_PAGE_SIZE);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(messageOf(error, 'History could not be loaded.'));
        }
      });
    return () => controller.abort();
    // `project` is a fresh object each render; what it names is `ref`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, attempt]);

  const loadOlder = useCallback(async () => {
    if (!commits) {
      return;
    }
    setLoadingOlder(true);
    try {
      const page = await loadProjectHistory(project, commits.length);
      setCommits([...commits, ...page]);
      setHasOlder(page.length === HISTORY_PAGE_SIZE);
    } catch (error) {
      toast.error(messageOf(error, 'Older versions could not be loaded.'));
    } finally {
      setLoadingOlder(false);
    }
  }, [commits, project]);

  const run = async (commit: ProjectCommit, action: 'revert' | 'fork' | 'download', work: () => Promise<void>) => {
    setBusy({ hash: commit.hash, action });
    try {
      await work();
    } catch (error) {
      toast.error(messageOf(error, 'That did not work. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const confirmRevert = (commit: ProjectCommit) => {
    setConfirmingRevert(null);
    if (!revert) {
      return;
    }
    void run(commit, 'revert', async () => {
      await revert(commit.hash);
      toast.success(`The project is back to version ${shortCommit(commit.hash)}. Publish to put it live.`);
      onClose();
    });
  };

  const fork = (commit: ProjectCommit) =>
    void run(commit, 'fork', async () => {
      if (!('chatInitialId' in project)) {
        return;
      }
      const chatInitialId = project.chatInitialId;
      // The fork opens in place of this page, so staying for edits not yet saved comes before it's made.
      await leavePage(async () => {
        const { initialId } = await forkProject(chatInitialId, commit.hash);
        onOpenProject(initialId);
      });
    });

  const download = (commit: ProjectCommit) =>
    void run(commit, 'download', () => downloadProjectArchive(project, archiveName(name), commit.hash));

  return (
    <>
      <Modal onClose={onClose} title="History" description={name}>
        {loadError !== null ? (
          <div role="alert" className="grid gap-2 text-sm text-content-secondary">
            <p>{loadError}</p>
            <Button className="justify-self-start" size="xs" variant="neutral" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : commits === null ? (
          <p className="text-sm text-content-tertiary" role="status">
            Loading history…
          </p>
        ) : commits.length === 0 ? (
          <p className="text-sm text-content-secondary">
            {'chatInitialId' in project
              ? "No saved versions yet. When you're happy with a change, ask the agent to save a version."
              : 'No saved versions yet. A version is saved each time a change is published.'}
          </p>
        ) : (
          <>
            {canRevert && !revert ? (
              <p className="mb-3 text-xs text-content-tertiary">Open the project to go back to a version.</p>
            ) : null}
            <ol className="grid gap-2" aria-label="Versions">
              {commits.map((commit) => {
                const title = commitTitle(commit.message);
                const pending = busy?.hash === commit.hash ? busy.action : null;
                return (
                  <li
                    key={commit.hash}
                    className="grid min-w-0 gap-2 rounded-lg border border-bolt-elements-borderColor p-3 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-content-primary [overflow-wrap:anywhere]">{title}</p>
                      <p className="text-xs text-content-tertiary [overflow-wrap:anywhere]">
                        {commit.author.name || commit.author.email} ·{' '}
                        <time dateTime={new Date(commit.committedAt * 1_000).toISOString()}>
                          {formatDistanceToNowStrict(commit.committedAt * 1_000, { addSuffix: true })}
                        </time>{' '}
                        · <code className="font-mono">{shortCommit(commit.hash)}</code>
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {canRevert && revert ? (
                        <Button
                          size="xs"
                          variant="neutral"
                          aria-label={`Restore ${shortCommit(commit.hash)}`}
                          disabled={busy !== null}
                          loading={pending === 'revert'}
                          onClick={() => setConfirmingRevert(commit)}
                        >
                          Restore
                        </Button>
                      ) : null}
                      {canFork ? (
                        <Button
                          size="xs"
                          variant="neutral"
                          aria-label={`Make a copy from ${shortCommit(commit.hash)}`}
                          disabled={busy !== null}
                          loading={pending === 'fork'}
                          onClick={() => fork(commit)}
                        >
                          Make a copy
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant="subtle"
                        aria-label={`Download ZIP of ${shortCommit(commit.hash)}`}
                        disabled={busy !== null}
                        loading={pending === 'download'}
                        onClick={() => download(commit)}
                      >
                        Download ZIP
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
            {hasOlder ? (
              <Button
                className="mt-3"
                size="xs"
                variant="subtle"
                loading={loadingOlder}
                onClick={() => void loadOlder()}
              >
                Show older versions
              </Button>
            ) : null}
          </>
        )}
      </Modal>
      {confirmingRevert ? (
        <ConfirmationDialog
          onClose={() => setConfirmingRevert(null)}
          onConfirm={() => confirmRevert(confirmingRevert)}
          confirmText="Restore"
          dialogTitle={`Restore ${shortCommit(confirmingRevert.hash)}?`}
          dialogBody={
            <div className="grid gap-2">
              <p className="[overflow-wrap:anywhere]">{commitTitle(confirmingRevert.message)}</p>
              <p>
                The project&apos;s files go back to this version, and files added since are removed. Nothing goes live
                until you publish, and every version stays in the history.
              </p>
            </div>
          }
        />
      ) : null}
    </>
  );
}

/** A file name from a project's name: lower case, with dashes for anything else. */
export function archiveName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}
