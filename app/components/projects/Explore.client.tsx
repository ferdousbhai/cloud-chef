import { useEffect, useState } from 'react';
import { CopyIcon, ExternalLinkIcon } from '@radix-ui/react-icons';
import { Button, buttonClassNames } from '@ui/Button';
import { ProjectTitle } from '~/components/ProjectTitle';
import { loadPublicProjects, type PublicProject } from '~/lib/cloudflare/org-projects.client';
import { openProjectWorkspace } from '~/lib/cloudflare/projects.client';
import { messageOf } from '~/lib/json-request';
import { CopyProjectDialog } from './CopyProjectDialog.client';
import { ProjectThumbnail } from './ProjectCard';

/**
 * Everyone's public projects, newest first: each one's site, who made it, and a way to make a copy of it in
 * the account the person is working in.
 */
export function Explore({ onOpenProject = openProjectWorkspace }: { onOpenProject?: (initialId: string) => void }) {
  const [projects, setProjects] = useState<PublicProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copying, setCopying] = useState<PublicProject | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadPublicProjects(controller.signal)
      .then(setProjects)
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(messageOf(cause, 'Public projects could not be loaded. Try again.'));
        }
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <main className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 sm:px-6 lg:px-8">
      <div className="grid gap-1">
        <h1 className="text-lg font-semibold text-content-primary">Explore</h1>
        <p className="text-sm text-content-secondary">
          Projects people have made public. Open one’s site, or make a copy of your own to change.
        </p>
      </div>
      {error !== null ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-content-secondary">
          <span>{error}</span>
          <Button
            size="xs"
            variant="neutral"
            onClick={() => {
              setError(null);
              setAttempt((count) => count + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : projects === null ? (
        <p className="text-sm text-content-tertiary" role="status">
          Loading public projects…
        </p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-content-secondary">
          No public projects yet. Make one of yours public from its card’s menu.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <PublicProjectCard key={project.id} project={project} onCopy={() => setCopying(project)} />
          ))}
        </ul>
      )}
      {copying ? (
        <CopyProjectDialog
          project={{ id: copying.id, name: copying.name }}
          onOpenProject={onOpenProject}
          onClose={() => setCopying(null)}
        />
      ) : null}
    </main>
  );
}

function PublicProjectCard({ project, onCopy }: { project: PublicProject; onCopy: () => void }) {
  const title = project.fullName ?? project.name;
  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 shadow-xs">
      <ProjectThumbnail siteUrl={project.siteUrl} siteFramed={project.siteFrameable !== false} />
      <div className="flex min-w-0 flex-1 flex-col gap-3 border-t border-bolt-elements-borderColor p-3">
        <div className="min-w-0">
          <h3 className="truncate font-medium text-content-primary" title={title}>
            <ProjectTitle>{title}</ProjectTitle>
          </h3>
          <p className="truncate text-xs text-content-tertiary">By {project.owner.name}</p>
          {project.copiedFrom ? (
            <p className="truncate text-xs text-content-tertiary">
              Copied from {project.copiedFrom.fullName ?? 'another project'}
            </p>
          ) : null}
        </div>
        <div className="mt-auto flex min-w-0 flex-wrap items-center gap-2">
          <Button size="xs" icon={<CopyIcon />} aria-label={`Make a copy of ${title}`} onClick={onCopy}>
            Make a copy
          </Button>
          {project.siteUrl ? (
            <a
              href={project.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClassNames({ variant: 'neutral', size: 'xs' })}
              aria-label={`Open site: ${title}`}
            >
              <ExternalLinkIcon />
              Open site
            </a>
          ) : null}
        </div>
      </div>
    </li>
  );
}
