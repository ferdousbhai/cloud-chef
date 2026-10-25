import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useStore } from '@nanostores/react';
import { Button } from '@ui/Button';
import { userWorkspacePreparingStore, userWorkspaceUpgradingStore } from '~/lib/cloudflare/runtime-session';
import { workspacePreparingMessage } from '~/components/WorkspacePreparing';
import { loadTeamProjects, openTeamProject, type TeamProject } from '~/lib/cloudflare/org-projects.client';

type OrgProject = TeamProject;

/**
 * The team projects this person may edit, above their own apps (the ones they may only view are on the
 * projects home). Opening one starts (or returns to) the project's chat, whose workspace is the project's
 * repository; a new conversation there continues the same workspace, and the earlier ones stay to read.
 */
export function OrgProjectsList({
  userId,
  inTeam = false,
  query,
  onNavigate,
}: {
  userId: string | null;
  /** Whether the person works in a team now; in their own space these are the projects they imported. */
  inTeam?: boolean;
  /** The sidebar's search, matched against the project's name and repository. */
  query: string;
  onNavigate: () => void;
}) {
  const [projects, setProjects] = useState<OrgProject[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  // Opening a project waits on the workspace; while it's set up or updated, say so.
  const workspacePreparing = useStore(userWorkspacePreparingStore);
  const workspaceUpgrading = useStore(userWorkspaceUpgradingStore);

  useEffect(() => {
    if (!userId) {
      return undefined;
    }
    const controller = new AbortController();
    setLoadFailed(false);
    void loadTeamProjects(controller.signal)
      .then((listed) => setProjects(listed.filter((project) => project.role === 'edit')))
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadFailed(true);
        }
      });
    return () => controller.abort();
  }, [userId, attempt]);

  if (!userId) {
    return null;
  }
  // In a person's own space these are the projects they imported, not a team's.
  const heading = inTeam ? 'Team projects' : 'Imported projects';
  if (loadFailed) {
    return (
      <section aria-label={heading} className="pb-3">
        <div
          className="rounded-lg border border-[var(--cc-content-warning)]/40 bg-[var(--cc-background-secondary)] p-3 text-xs text-content-secondary"
          role="alert"
        >
          <p>{heading} could not be loaded.</p>
          <Button className="mt-2" size="xs" variant="neutral" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </Button>
        </div>
      </section>
    );
  }
  const search = query.trim().toLowerCase();
  const shown = search ? projects.filter((project) => project.name.toLowerCase().includes(search)) : projects;
  if (shown.length === 0) {
    return null;
  }

  const open = async (project: OrgProject) => {
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

  return (
    <section aria-label={heading} className="pb-3">
      <h2 className="px-1 pb-2 text-xs font-black tracking-widest text-content-secondary uppercase">{heading}</h2>
      <div className="space-y-1.5">
        {shown.map((project) => (
          <button
            key={project.id}
            type="button"
            disabled={opening !== null}
            onClick={() => void open(project)}
            className="flex w-full min-w-0 flex-col rounded-lg px-3 py-2 text-left hover:bg-[var(--bolt-elements-item-backgroundActive)] disabled:opacity-60"
          >
            <span className="truncate font-medium text-content-primary">
              {opening === project.id ? `Opening ${project.name}…` : project.name}
            </span>
            {opening === project.id && workspacePreparing ? (
              <span className="mt-1 text-xs text-content-secondary" role="status">
                {workspacePreparingMessage(workspaceUpgrading)}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  );
}
