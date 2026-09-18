import { motion, MotionConfig, type Variants } from 'framer-motion';
import { memo, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmationDialog } from '@ui/ConfirmationDialog';
import type { ChatHistorySummary } from '~/lib/cloudflare/data-api';
import { cubicEasingFn } from '~/utils/easings';
import { logger } from 'cloudchef-agent/utils/logger';
import { HistoryItem } from './HistoryItem';
import { binDates } from './date-binning';
import { useSearchFilter } from '~/lib/hooks/useSearchFilter';
import { classNames } from '~/utils/classNames';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { useChatId } from '~/lib/stores/chatId';
import { Button } from '@ui/Button';
import { LinkButton } from '~/components/ui/LinkButton';
import { TextInput } from '@ui/TextInput';
import { PlusIcon } from '@radix-ui/react-icons';
import { removeChatHistoryItem, useChatHistory } from '~/lib/cloudflare/chat-history-db';
import { ProjectTitle } from '~/components/ProjectTitle';
import { Link } from '@tanstack/react-router';

const menuVariants = {
  closed: {
    opacity: 0,
    visibility: 'hidden',
    left: '-340px',
    transition: {
      duration: 0.2,
      ease: cubicEasingFn,
    },
  },
  open: {
    opacity: 1,
    visibility: 'initial',
    left: 0,
    transition: {
      duration: 0.2,
      ease: cubicEasingFn,
    },
  },
} satisfies Variants;

interface MenuProps {
  isOpen: boolean;
  onClose: () => void;
}

export const Menu = memo(({ isOpen, onClose }: MenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const userId = useUserIdOrNullOrLoading();
  const accountUserId = userId ?? null;
  const activeChatId = useChatId();
  const history = useChatHistory(accountUserId);
  const list = history.projects;
  const [deleteTarget, setDeleteTarget] = useState<ChatHistorySummary | null>(null);

  const { filteredItems: filteredList, handleSearchChange } = useSearchFilter({ items: list });

  const deleteItem = async (item: ChatHistorySummary) => {
    if (!accountUserId) {
      return;
    }

    try {
      await removeChatHistoryItem(accountUserId, item.initialId);
      if (activeChatId === item.initialId) {
        window.location.replace('/');
      }
    } catch (error) {
      toast.error('Failed to remove project');
      logger.error(error);
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
      const clickedMenuToggle = target.closest('[data-hamburger-menu]');
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

  const handleDeleteClick = (item: ChatHistorySummary) => {
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
        'side-menu fixed top-0 flex h-full max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-r-lg',
        'bg-[var(--bolt-elements-sidebar-background)] border-r border-border-transparent',
        'shadow-panel text-sm',
        'z-30',
      )}
    >
      <div aria-hidden className="h-[var(--header-height)] shrink-0 border-b" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="min-w-0 space-y-3 px-4 pb-5 pt-4">
          <LinkButton
            className="min-h-11 w-full min-w-0 max-w-full overflow-hidden rounded-lg px-4 no-underline"
            to="/"
            reloadDocument
            onClick={onClose}
            icon={<PlusIcon className="size-4 shrink-0" />}
          >
            <span className="truncate">Start new project</span>
          </LinkButton>
          <div className="relative min-w-0">
            <TextInput
              id="search-projects"
              className="w-full min-w-0 max-w-full"
              type="search"
              placeholder="Search projects..."
              onChange={handleSearchChange}
              aria-label="Search projects"
            />
          </div>
        </div>
        <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-1">
          <h2 className="text-xs font-black tracking-widest text-content-secondary uppercase">Projects</h2>
          <span className="text-xs tabular-nums text-content-tertiary">
            {list.length} {list.length === 1 ? 'project' : 'projects'}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5">
          {history.error != null && (
            <div
              className="mb-3 rounded-lg border border-[var(--cc-content-warning)]/40 bg-[var(--cc-background-secondary)] p-3 text-xs text-content-secondary"
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
              Loading projects…
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
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--bolt-elements-sidebar-background)] px-1 py-1.5 text-[11px] font-bold tracking-[0.06em] text-content-tertiary uppercase">
                <span>{category}</span>
                <span aria-hidden className="h-px flex-1 bg-border-transparent" />
              </div>
              <div className="space-y-1.5">
                {items.map((item) => (
                  <HistoryItem
                    key={item.initialId}
                    item={item}
                    handleDeleteClick={handleDeleteClick}
                    onNavigate={onClose}
                  />
                ))}
              </div>
            </section>
          ))}
          {deleteTarget && (
            <ConfirmationDialog
              onClose={closeDialog}
              confirmText="Remove"
              onConfirm={() => {
                void deleteItem(deleteTarget);
                closeDialog();
              }}
              dialogTitle="Remove project"
              dialogBody={
                <div className="space-y-2">
                  <p>
                    You are about to remove{' '}
                    <ProjectTitle className="font-medium text-content-primary">
                      {deleteTarget.description || 'Untitled project'}
                    </ProjectTitle>
                    .
                  </p>
                  <p className="text-content-secondary">
                    This removes it from your project list and schedules cleanup of its workspace and deployed
                    Cloudflare resources. Provider-retained logs and browser data are not erased. See the{' '}
                    <Link to="/privacy">Privacy notice</Link>.
                  </p>
                </div>
              }
            />
          )}
        </div>
      </div>
    </motion.aside>
  );
  return <MotionConfig reducedMotion="user">{content}</MotionConfig>;
});

Menu.displayName = 'Menu';
