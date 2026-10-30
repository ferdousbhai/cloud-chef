import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useStore } from '@nanostores/react';
import { format } from 'date-fns';
import { FileTextIcon } from '@radix-ui/react-icons';
import { userWorkspacePreparingStore, userWorkspaceUpgradingStore } from '~/lib/cloudflare/runtime-session';
import { workspacePreparingMessage } from '~/components/WorkspacePreparing';
import { loadTeamProjects, openTeamProject, type TeamProject } from '~/lib/cloudflare/org-projects.client';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { classNames } from '~/utils/classNames';

/**
 * The projects kept in the account this person works in that they may edit: imported or uploaded ones in Personal,
 * the team's in a team (the ones they may only view are on the projects home), by when each was added.
 */
export function useEditableProjects(userId: string | null) {
  const [projects, setProjects] = useState<TeamProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!userId) {
      return undefined;
    }
    const controller = new AbortController();
    void loadTeamProjects(controller.signal)
      .then((listed) => {
        setProjects(listed.filter((project) => project.role === 'edit'));
        setLoadFailed(false);
        setIsLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadFailed(true);
          setIsLoading(false);
        }
      });
    return () => controller.abort();
  }, [userId, attempt]);

  const retry = useCallback(() => {
    setLoadFailed(false);
    setAttempt((count) => count + 1);
  }, []);

  return { projects, isLoading, loadFailed, retry };
}

/** Which project is being opened; while one is, the others wait. */
export function useOpenProject(onNavigate: () => void) {
  const [opening, setOpening] = useState<string | null>(null);
  const open = async (project: TeamProject) => {
    setOpening(project.id);
    try {
      const left = await openTeamProject(project, onNavigate);
      if (!left) {
        setOpening(null);
      }
    } catch {
      toast.error(`${project.name} could not be opened. Try again.`);
      setOpening(null);
    }
  };
  return { opening, open };
}

/**
 * One of those projects in the sidebar's list. Opening it starts (or returns to) the project's workspace, whose files
 * are the project's repository; a new conversation there continues the same workspace.
 */
export function ProjectItem({
  project,
  opening,
  onOpen,
}: {
  project: TeamProject;
  /** The project being opened, if any. */
  opening: string | null;
  onOpen: (project: TeamProject) => void;
}) {
  // Opening a project waits on the workspace; while it's set up or updated, say so.
  const workspacePreparing = useStore(userWorkspacePreparingStore);
  const workspaceUpgrading = useStore(userWorkspaceUpgradingStore);
  const linkedProject = useStore(workbenchStore.linkedProject);
  const isOpen = project.repo !== null && linkedProject?.repo === project.repo;
  const isOpening = opening === project.id;

  return (
    <div
      className={classNames(
        'group relative flex min-w-0 items-center overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-(--cc-background-tertiary) p-1.5 text-sm transition-[border-color,background-color,box-shadow]',
        'hover:bg-(--bolt-elements-sidebar-active-item-background) hover:shadow-xs',
        { 'bg-(--bolt-elements-sidebar-active-item-background) shadow-xs': isOpen },
      )}
    >
      <button
        type="button"
        disabled={opening !== null}
        aria-current={isOpen ? 'page' : undefined}
        onClick={() => onOpen(project)}
        className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg p-2 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-60"
      >
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-(--cc-background-secondary) text-content-accent shadow-xs">
          <FileTextIcon className="size-4" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="block truncate font-bold leading-5 text-content-primary">
            {isOpening ? `Opening ${project.name}…` : project.name}
          </span>
          {isOpening && workspacePreparing ? (
            <span className="mt-0.5 text-xs text-content-secondary" role="status">
              {workspacePreparingMessage(workspaceUpgrading)}
            </span>
          ) : project.createdAt ? (
            <span className="mt-0.5 text-xs font-medium text-content-tertiary">
              {format(new Date(project.createdAt), 'p')}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  );
}
