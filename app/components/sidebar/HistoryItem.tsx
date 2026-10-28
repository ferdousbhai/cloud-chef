import { Link } from '@tanstack/react-router';
import { classNames } from '~/utils/classNames';
import type { WorkspaceSummary } from '~/lib/cloudflare/data-api';
import { useEditChatDescription } from '~/lib/hooks/useEditChatDescription';
import { CheckIcon, FileTextIcon, Pencil1Icon, TrashIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { format } from 'date-fns';
import { ProjectTitle } from '~/components/ProjectTitle';
import { useWorkspaceId } from '~/lib/stores/workspaceId';

interface HistoryItemProps {
  item: WorkspaceSummary;
  handleDeleteClick: (item: WorkspaceSummary) => void;
  onNavigate: () => void;
}

export function HistoryItem({ item, handleDeleteClick, onNavigate }: HistoryItemProps) {
  const activeChatId = useWorkspaceId();
  const isActiveChat = activeChatId === item.initialId;

  const { editing, handleChange, handleBlur, handleSubmit, handleKeyDown, currentDescription, toggleEditMode } =
    useEditChatDescription({
      initialDescription: item.description ?? '',
      customChatId: item.id,
      syncWithGlobalStore: isActiveChat,
    });

  // New projects can be persisted before their first prompt supplies a title.
  // Keep those rows visible and distinguishable by showing their creation time.
  const description = currentDescription.trim() || 'Untitled project';
  const projectTime = format(new Date(item.timestamp), 'p');

  return (
    <div
      className={classNames(
        'group relative flex min-w-0 items-center gap-1 overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-[var(--cc-background-tertiary)] p-1.5 text-sm text-content-secondary transition-[border-color,background-color,box-shadow,transform]',
        'hover:border-accent-500/50 hover:bg-[var(--bolt-elements-sidebar-active-item-background)] hover:shadow-sm',
        {
          'border-accent-500/70 bg-[var(--bolt-elements-sidebar-active-item-background)] shadow-sm': isActiveChat,
        },
      )}
    >
      {editing ? (
        <form onSubmit={handleSubmit} className="flex min-w-0 flex-1 items-center gap-2">
          <TextInput
            id={`description-${item.id}`}
            aria-label="Project name"
            className="min-w-0 flex-1"
            autoFocus
            value={currentDescription}
            onChange={handleChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />
          <Button
            type="submit"
            variant="neutral"
            icon={<CheckIcon />}
            size="xs"
            inline
            tip="Save project name"
            aria-label="Save project name"
            // Keeps the field focused, so leaving it does not put the name back before this saves it.
            onMouseDown={(event) => event.preventDefault()}
          />
        </form>
      ) : (
        <>
          <Link
            to="/chat/$id"
            params={{ id: item.initialId }}
            onClick={onNavigate}
            aria-current={isActiveChat ? 'page' : undefined}
            className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg p-2 text-content-primary no-underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--cc-background-secondary)] text-content-accent shadow-sm">
              <FileTextIcon className="size-4" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <ProjectTitle className="block truncate font-bold leading-5 text-content-primary">
                {description}
              </ProjectTitle>
              <span className="mt-0.5 text-xs font-medium text-content-tertiary">{projectTime}</span>
            </span>
          </Link>
          <div className="flex shrink-0 items-center gap-0.5 text-content-tertiary opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            <ChatActionButton
              toolTipContent="Rename"
              label={`Rename ${description}`}
              icon={<Pencil1Icon />}
              onClick={() => {
                toggleEditMode();
              }}
            />
            <ChatActionButton
              toolTipContent="Delete"
              label={`Delete ${description}`}
              icon={<TrashIcon />}
              onClick={() => {
                handleDeleteClick(item);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

const ChatActionButton = ({
  toolTipContent,
  label,
  icon,
  onClick,
}: {
  toolTipContent: string;
  /** Names the project too: a screen reader's list of buttons otherwise reads "Rename, Delete" for every row. */
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) => {
  return (
    <Button variant="neutral" icon={icon} inline size="xs" tip={toolTipContent} aria-label={label} onClick={onClick} />
  );
};
