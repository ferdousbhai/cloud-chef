import { useEffect, useState } from 'react';
import { z } from 'zod';
import { toast } from 'sonner';
import { useStore } from '@nanostores/react';
import { Button } from '@ui/Button';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';
import { userWorkspacePreparingStore, userWorkspaceUpgradingStore } from '~/lib/cloudflare/runtime-session';
import { workspacePreparingMessage } from '~/components/WorkspacePreparing';

const projectsSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), repoFullName: z.string() })),
});

type OrgProject = z.infer<typeof projectsSchema>['projects'][number];

/**
 * The organization's GitHub projects this person may work on, above their own apps. Opening one starts
 * (or returns to) the chat whose workspace is that repository.
 */
export function OrgProjectsList({
  userId,
  query,
  onNavigate,
}: {
  userId: string | null;
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
    void fetch('/api/org-projects', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`GitHub projects could not be loaded (${response.status}).`);
        }
        return projectsSchema.parse(await response.json());
      })
      .then((parsed) => setProjects(parsed.projects))
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
  if (loadFailed) {
    return (
      <section aria-label="GitHub projects" className="pb-3">
        <div
          className="rounded-lg border border-[var(--cc-content-warning)]/40 bg-[var(--cc-background-secondary)] p-3 text-xs text-content-secondary"
          role="alert"
        >
          <p>GitHub projects could not be loaded.</p>
          <Button className="mt-2" size="xs" variant="neutral" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </Button>
        </div>
      </section>
    );
  }
  const search = query.trim().toLowerCase();
  const shown = search
    ? projects.filter(
        (project) => project.name.toLowerCase().includes(search) || project.repoFullName.toLowerCase().includes(search),
      )
    : projects;
  if (shown.length === 0) {
    return null;
  }

  const open = async (project: OrgProject) => {
    setOpening(project.id);
    try {
      const { initialId } = await executeDataOperation(api.messages.openLinkedChat, {
        sessionId: userId,
        id: crypto.randomUUID(),
        orgProjectId: project.id,
      });
      onNavigate();
      window.location.assign(`/chat/${encodeURIComponent(initialId)}`);
    } catch {
      toast.error(`${project.name} could not be opened. Try again.`);
      setOpening(null);
    }
  };

  return (
    <section aria-label="GitHub projects" className="pb-3">
      <h2 className="px-1 pb-2 text-xs font-black tracking-widest text-content-secondary uppercase">GitHub projects</h2>
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
            <span className="truncate text-xs text-content-tertiary">{project.repoFullName}</span>
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
