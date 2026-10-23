import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useStore } from '@nanostores/react';
import { Link } from '@tanstack/react-router';
import { format } from 'date-fns';
import { ChevronDownIcon, PlusIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api, type DataOperationResult } from '~/lib/cloudflare/data-api';
import { userWorkspacePreparingStore, userWorkspaceUpgradingStore } from '~/lib/cloudflare/runtime-session';
import { workspacePreparingMessage } from '~/components/WorkspacePreparing';
import { loadTeamProjects, openTeamProject, type TeamProject } from '~/lib/cloudflare/org-projects.client';

type OrgProject = TeamProject;

/**
 * The team projects this person may edit, above their own apps (the ones they may only view are on the
 * projects home). Opening one starts (or returns to) the project's current conversation, whose workspace is
 * the project's repository; a new conversation takes the workspace along, and the earlier ones stay to read.
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
  const [expanded, setExpanded] = useState<string | null>(null);
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
  if (loadFailed) {
    return (
      <section aria-label="Team projects" className="pb-3">
        <div
          className="rounded-lg border border-[var(--cc-content-warning)]/40 bg-[var(--cc-background-secondary)] p-3 text-xs text-content-secondary"
          role="alert"
        >
          <p>Team projects could not be loaded.</p>
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

  const open = async (project: OrgProject, fresh: boolean) => {
    setOpening(project.id);
    try {
      const left = await openTeamProject(project, fresh, onNavigate);
      if (!left) {
        setOpening(null);
      }
    } catch {
      toast.error(`${project.name} could not be opened. Try again.`);
      setOpening(null);
    }
  };

  return (
    <section aria-label="Team projects" className="pb-3">
      <h2 className="px-1 pb-2 text-xs font-black tracking-widest text-content-secondary uppercase">Team projects</h2>
      <div className="space-y-1.5">
        {shown.map((project) => (
          <div key={project.id} className="min-w-0">
            <div className="flex min-w-0 items-start gap-1">
              <button
                type="button"
                disabled={opening !== null}
                onClick={() => void open(project, false)}
                className="flex min-w-0 flex-1 flex-col rounded-lg px-3 py-2 text-left hover:bg-[var(--bolt-elements-item-backgroundActive)] disabled:opacity-60"
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
              <Button
                className="mt-2"
                size="xs"
                variant="neutral"
                inline
                icon={
                  <ChevronDownIcon
                    className={expanded === project.id ? 'rotate-180 transition-transform' : 'transition-transform'}
                  />
                }
                tip="Conversations"
                aria-label={`${project.name} conversations`}
                aria-expanded={expanded === project.id}
                onClick={() => setExpanded((current) => (current === project.id ? null : project.id))}
              />
            </div>
            {expanded === project.id ? (
              <ProjectConversations
                userId={userId}
                project={project}
                disabled={opening !== null}
                onStart={() => void open(project, true)}
                onNavigate={onNavigate}
              />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

type EarlierConversation = DataOperationResult<'messages.linkedChatHistory'>[number];

/** Start a new conversation on a project, or read an earlier one (which takes no more messages). */
function ProjectConversations({
  userId,
  project,
  disabled,
  onStart,
  onNavigate,
}: {
  userId: string;
  project: OrgProject;
  disabled: boolean;
  onStart: () => void;
  onNavigate: () => void;
}) {
  const [earlier, setEarlier] = useState<EarlierConversation[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void executeDataOperation(api.messages.linkedChatHistory, { orgProjectId: project.id })
      .then((conversations) => {
        if (!cancelled) {
          setEarlier(conversations);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userId, project.id]);

  return (
    <div className="ml-3 grid gap-1 border-l border-bolt-elements-borderColor py-1 pl-3 text-xs">
      <Button
        className="justify-self-start"
        size="xs"
        variant="neutral"
        icon={<PlusIcon />}
        disabled={disabled}
        onClick={onStart}
      >
        New conversation
      </Button>
      <p className="text-content-tertiary">
        The current conversation stops and stays to read; changes you haven&apos;t published come along.
      </p>
      {loadFailed ? (
        <p className="text-content-secondary">Earlier conversations could not be loaded.</p>
      ) : earlier === null ? (
        <p className="text-content-tertiary" role="status">
          Loading earlier conversations…
        </p>
      ) : earlier.length > 0 ? (
        <>
          <h3 className="mt-1 font-medium text-content-secondary">Earlier conversations</h3>
          <ul className="grid gap-0.5">
            {earlier.map((conversation) => (
              <li key={conversation.initialId} className="min-w-0">
                <Link
                  to="/chat/$id"
                  params={{ id: conversation.initialId }}
                  onClick={onNavigate}
                  className="flex min-w-0 gap-2 rounded px-1 py-0.5 text-content-secondary hover:bg-[var(--bolt-elements-item-backgroundActive)]"
                >
                  <span className="min-w-0 flex-1 truncate">{conversation.description || 'Untitled conversation'}</span>
                  <span className="shrink-0 text-content-tertiary">
                    {format(new Date(conversation.archivedAt), 'PP')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
