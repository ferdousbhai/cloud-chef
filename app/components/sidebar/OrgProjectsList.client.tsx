import { useEffect, useState } from 'react';
import { z } from 'zod';
import { toast } from 'sonner';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';

const projectsSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), repoFullName: z.string() })),
});

type OrgProject = z.infer<typeof projectsSchema>['projects'][number];

/**
 * The organization's GitHub projects this person may work on, above their own apps. Opening one starts
 * (or returns to) the chat whose workspace is that repository.
 */
export function OrgProjectsList({ userId, onNavigate }: { userId: string | null; onNavigate: () => void }) {
  const [projects, setProjects] = useState<OrgProject[]>([]);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) {
      return undefined;
    }
    const controller = new AbortController();
    void fetch('/api/org-projects', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => (response.ok ? projectsSchema.safeParse(await response.json()) : null))
      .then((parsed) => {
        if (parsed?.success) {
          setProjects(parsed.data.projects);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [userId]);

  if (!userId || projects.length === 0) {
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
    <section aria-label="GitHub projects" className="px-3 pb-3">
      <h2 className="px-1 pb-2 text-xs font-black tracking-widest text-content-secondary uppercase">GitHub projects</h2>
      <div className="space-y-1.5">
        {projects.map((project) => (
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
          </button>
        ))}
      </div>
    </section>
  );
}
