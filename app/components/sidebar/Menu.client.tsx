import { motion, MotionConfig, type Variants } from 'motion/react';
import { memo, useEffect, useRef, useState } from 'react';
import type { WorkspaceSummary } from '~/lib/cloudflare/data-api';
import { cubicEasingFn } from '~/utils/easings';
import { logger } from 'cloudchef-agent/utils/logger';
import { HistoryItem } from './HistoryItem';
import { binDates } from './date-binning';
import { classNames } from '~/utils/classNames';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { useWorkspaceId } from '~/lib/stores/workspaceId';
import { Button, buttonClassNames } from '@ui/Button';
import { Link } from '@tanstack/react-router';
import { LinkButton } from '~/components/ui/LinkButton';
import { TextInput } from '@ui/TextInput';
import { CheckCircledIcon, GlobeIcon, HomeIcon, PersonIcon, PlusIcon } from '@radix-ui/react-icons';
import { removeWorkspaceHistoryItem, useWorkspaceHistory } from '~/lib/cloudflare/workspace-history-db';
import { AppDeletionNotice, DeleteProjectDialog } from '~/components/projects/DeleteProjectDialog.client';
import { ProjectItem, useEditableProjects, useOpenProject } from './ProjectItem.client';
import type { TeamProject } from '~/lib/cloudflare/org-projects.client';
import { WorkspaceSwitcher } from '~/components/header/WorkspaceSwitcher';
import { useStore } from '@nanostores/react';
import { userWorkspacePreparingStore, userWorkspaceUpgradingStore } from '~/lib/cloudflare/runtime-session';
import { workspacePreparingMessage } from '~/components/WorkspacePreparing';
import { authClient } from '~/lib/auth-client';
import { leavePage } from '~/lib/hooks/useUnsavedEditsGuard';

const menuVariants = {
  closed: {
    opacity: 0,
    visibility: 'hidden',
    x: '-100%',
    transition: {
      duration: 0.5,
      ease: cubicEasingFn,
    },
  },
  open: {
    opacity: 1,
    visibility: 'initial',
    x: 0,
    transition: {
      duration: 0.5,
      ease: cubicEasingFn,
    },
  },
} satisfies Variants;

interface MenuProps {
  isOpen: boolean;
  /** How many approvals wait, as the header counted them for its button. */
  waitingApprovals: number;
  onClose: () => void;
}

/** One row of the sidebar's projects: one of the person's own apps, or a project kept in the account. */
type ListedProject =
  | { kind: 'app'; key: string; timestamp: string; item: WorkspaceSummary }
  | { kind: 'project'; key: string; timestamp: string; project: TeamProject };

/**
 * Removes one of this person's projects. Removing the open one leaves it, so over editor edits not yet
 * saved it asks first, before anything is deleted; removing another needs no such question.
 */
export async function removeProject(
  sessionId: string,
  workspaceId: string,
  openChatId: string | undefined,
  remove = removeWorkspaceHistoryItem,
): Promise<void> {
  if (openChatId !== workspaceId) {
    await remove(sessionId, workspaceId);
    return;
  }
  await leavePage(async () => {
    await remove(sessionId, workspaceId);
    window.location.replace('/');
  });
}

export const Menu = memo(({ isOpen, waitingApprovals, onClose }: MenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const userId = useUserIdOrNullOrLoading();
  const accountUserId = userId ?? null;
  const activeChatId = useWorkspaceId();
  const history = useWorkspaceHistory(accountUserId);
  // Projects come from the workspace in the user's Cloudflare account; while it's set up or updated, say so.
  const workspacePreparing = useStore(userWorkspacePreparingStore);
  const workspaceUpgrading = useStore(userWorkspaceUpgradingStore);
  const { data: session } = authClient.useSession();
  // A member limited to the organization's GitHub projects can't start apps of their own here.
  const draftsAllowed = session?.context?.kind !== 'organization' || session.context.draftsAllowed;
  const username = session?.user.username ?? null;
  // Approvals gather every team's this person is an admin of.
  const teamAdmin =
    session?.contexts.some((context) => context.kind === 'organization' && context.role === 'admin') ?? false;
  const added = useEditableProjects(accountUserId);
  const { opening, open } = useOpenProject(onClose);
  // Every project in one list, however it began: made here, imported from GitHub, uploaded, or the team's.
  const list: ListedProject[] = [
    ...history.projects.map((item) => ({
      kind: 'app' as const,
      key: item.initialId,
      timestamp: item.timestamp,
      item,
    })),
    ...added.projects.map((project) => ({
      kind: 'project' as const,
      key: project.id,
      timestamp: project.createdAt ?? new Date(0).toISOString(),
      project,
    })),
  ];
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceSummary | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const search = searchQuery.trim().toLowerCase();
  const filteredList = search
    ? list.filter((entry) =>
        (entry.kind === 'app' ? (entry.item.description ?? '') : entry.project.name).toLowerCase().includes(search),
      )
    : list;

  const deleteItem = async (item: WorkspaceSummary) => {
    if (!accountUserId) {
      return;
    }
    try {
      await removeProject(accountUserId, item.initialId, activeChatId);
    } catch (error) {
      logger.error(error);
      throw new Error('The project couldn’t be deleted. Try again.');
    }
  };

  const closeDialog = () => {
    setDeleteTarget(null);
  };

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (deleteTarget) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      // The space switcher's menu opens outside the sidebar, and choosing from it shouldn't close the sidebar first.
      const clickedMenuToggle = target.closest('[data-hamburger-menu], [role="menu"]');
      if (clickedMenuToggle) {
        return;
      }
      if (menuRef.current && !menuRef.current.contains(target)) {
        onClose();
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !deleteTarget) {
        onClose();
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [deleteTarget, isOpen, onClose]);

  const handleDeleteClick = (item: WorkspaceSummary) => {
    setDeleteTarget(item);
  };

  if (!accountUserId) {
    return null;
  }

  const content = (
    <motion.aside
      id="project-sidebar"
      aria-label="Projects"
      aria-hidden={!isOpen}
      inert={!isOpen}
      ref={menuRef}
      initial="closed"
      animate={isOpen ? 'open' : 'closed'}
      variants={menuVariants}
      style={{ width: 'min(320px, calc(100dvw - 24px))' }}
      className={classNames(
        'side-menu fixed left-0 top-0 flex h-full max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-r-lg',
        'bg-(--bolt-elements-sidebar-background) border-r border-border-transparent',
        'shadow-panel text-sm',
        'z-30',
      )}
    >
      <div aria-hidden className="h-(--header-height) shrink-0 border-b" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="min-w-0 space-y-3 px-4 pb-5 pt-4">
          <WorkspaceSwitcher className="w-full justify-between!" />
          {draftsAllowed ? (
            <LinkButton
              className="min-h-11 w-full min-w-0 max-w-full overflow-hidden rounded-lg px-4 no-underline"
              to="/"
              reloadDocument
              onClick={onClose}
              icon={<PlusIcon className="size-4 shrink-0" />}
            >
              <span className="truncate">Start new project</span>
            </LinkButton>
          ) : null}
          <div className="relative min-w-0">
            <TextInput
              id="search-projects"
              className="w-full min-w-0 max-w-full"
              type="search"
              placeholder="Search projects..."
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="Search projects"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5">
          <div className="flex items-baseline justify-between gap-3 px-1 pb-2 pt-1">
            <h2 className="text-xs font-bold tracking-widest text-content-secondary uppercase">Projects</h2>
            <span className="text-xs tabular-nums text-content-tertiary">
              {list.length} {list.length === 1 ? 'project' : 'projects'}
            </span>
          </div>
          {added.loadFailed && (
            <div
              className="mb-3 rounded-lg border border-(--cc-content-warning)/40 bg-(--cc-background-secondary) p-3 text-xs text-content-secondary"
              role="alert"
            >
              <p>Some projects could not be loaded.</p>
              <Button className="mt-2" size="xs" variant="neutral" onClick={added.retry}>
                Try again
              </Button>
            </div>
          )}
          {history.error != null && (
            <div
              className="mb-3 rounded-lg border border-(--cc-content-warning)/40 bg-(--cc-background-secondary) p-3 text-xs text-content-secondary"
              role="alert"
            >
              <p>Projects could not be refreshed.</p>
              <Button className="mt-2" size="xs" variant="neutral" onClick={history.retry}>
                Try again
              </Button>
            </div>
          )}
          {history.isLoading && list.length === 0 && (
            <p className="px-4 text-sm text-content-tertiary" role="status">
              {workspacePreparing ? workspacePreparingMessage(workspaceUpgrading) : 'Loading projects…'}
            </p>
          )}
          {filteredList.length === 0 && (
            <div className="px-4 text-sm text-gray-500 dark:text-gray-400">
              {!history.isLoading && !history.error && list.length === 0
                ? 'No previous projects'
                : list.length > 0
                  ? 'No matches found'
                  : null}
            </div>
          )}
          {binDates(filteredList).map(({ category, items }) => (
            <section key={category} aria-label={category} className="mt-4 space-y-2 first:mt-0">
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-(--bolt-elements-sidebar-background) px-1 py-1.5 text-xs font-bold tracking-wider text-content-tertiary uppercase">
                <span>{category}</span>
                <span aria-hidden className="h-px flex-1 bg-border-transparent" />
              </div>
              <div className="space-y-1.5">
                {items.map((entry) =>
                  entry.kind === 'app' ? (
                    <HistoryItem
                      key={entry.key}
                      item={entry.item}
                      handleDeleteClick={handleDeleteClick}
                      onNavigate={onClose}
                    />
                  ) : (
                    <ProjectItem
                      key={entry.key}
                      project={entry.project}
                      opening={opening}
                      onOpen={(project) => void open(project)}
                    />
                  ),
                )}
              </div>
            </section>
          ))}
          {deleteTarget && (
            <DeleteProjectDialog
              name={deleteTarget.description || 'Untitled project'}
              summary={<AppDeletionNotice />}
              onDelete={() => deleteItem(deleteTarget)}
              onDeleted={closeDialog}
              onClose={closeDialog}
            />
          )}
        </div>
        <nav aria-label="More" className="shrink-0 space-y-1 border-t px-3 py-3">
          <LinkButton
            variant="subtle"
            size="xs"
            className="w-full justify-start"
            to="/feed"
            onClick={onClose}
            icon={<HomeIcon />}
          >
            Feed
          </LinkButton>
          <LinkButton
            variant="subtle"
            size="xs"
            className="w-full justify-start"
            to="/explore"
            onClick={onClose}
            icon={<GlobeIcon />}
          >
            Explore
          </LinkButton>
          {username ? (
            <Link
              className={buttonClassNames({ variant: 'subtle', size: 'xs', className: 'w-full justify-start' })}
              to="/$username"
              params={{ username }}
              onClick={onClose}
            >
              <PersonIcon />
              Your page
            </Link>
          ) : null}
          {teamAdmin ? (
            <LinkButton
              variant="subtle"
              size="xs"
              className="w-full justify-start"
              to="/approvals"
              onClick={onClose}
              icon={<CheckCircledIcon />}
            >
              {waitingApprovals > 0 ? `Approvals (${waitingApprovals})` : 'Approvals'}
            </LinkButton>
          ) : null}
        </nav>
      </div>
    </motion.aside>
  );
  return <MotionConfig reducedMotion="user">{content}</MotionConfig>;
});

Menu.displayName = 'Menu';
