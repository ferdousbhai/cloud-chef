import { Button } from '@ui/Button';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChatBubbleIcon,
  CheckIcon,
  ChevronDownIcon,
  Pencil1Icon,
  PlusIcon,
} from '@radix-ui/react-icons';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useState } from 'react';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { Spinner } from '@ui/Spinner';
import { useAreFilesSaving } from '~/lib/stores/fileUpdateCounter';
import { SubchatDialogs } from './SubchatDialogs';
import { createSubchatOptions, getSubchatLabel, getSubchatNavigation, type SubchatSummary } from './subchat-model';

interface SubchatBarProps {
  chatId: string;
  subchats?: SubchatSummary[];
  currentSubchatIndex: number;
  isStreaming: boolean;
  chatDisabled: boolean;
  userId: string | null;
  handleCreateSubchat: () => Promise<boolean>;
  handleRenameSubchat: (title: string) => Promise<boolean>;
  isSubchatLoaded: boolean;
}

export function SubchatBar({
  chatId,
  subchats,
  currentSubchatIndex,
  isStreaming,
  chatDisabled,
  userId,
  handleCreateSubchat,
  handleRenameSubchat,
  isSubchatLoaded,
}: SubchatBarProps) {
  const interactionContext = JSON.stringify([userId, chatId, currentSubchatIndex]);
  const [createDialog, setCreateDialog] = useState<{ context: string; token: symbol } | null>(null);
  const activeCreateDialog = createDialog?.context === interactionContext ? createDialog : null;
  const [pendingCreates, setPendingCreates] = useState<ReadonlyMap<string, symbol>>(() => new Map());
  const activeCreateToken = pendingCreates.get(interactionContext);
  const isCreatingSubchat = activeCreateToken !== undefined;
  const [renameDialog, setRenameDialog] = useState<{ context: string; token: symbol; value: string } | null>(null);
  const activeRenameDialog = renameDialog?.context === interactionContext ? renameDialog : null;
  const [pendingRenames, setPendingRenames] = useState<ReadonlyMap<string, symbol>>(() => new Map());
  const activeRenameToken = pendingRenames.get(interactionContext);
  const isRenaming = activeRenameToken !== undefined;
  const areFilesSaving = useAreFilesSaving();

  useEffect(() => {
    setCreateDialog(null);
    setRenameDialog(null);
  }, [interactionContext]);

  const subchatCount = subchats?.length ?? 1;
  const { hasMultipleSubchats, canNavigatePrev, canNavigateNext, canCreateSubchat } = getSubchatNavigation(
    subchatCount,
    currentSubchatIndex,
    userId !== null,
  );

  const busyTip = isCreatingSubchat
    ? 'Creating chat...'
    : isStreaming
      ? 'Wait for the current response to finish'
      : !isSubchatLoaded
        ? 'Loading...'
        : areFilesSaving
          ? 'Saving...'
          : undefined;
  const interactionsDisabled = busyTip !== undefined;

  const handleNavigateToSubchat = (index: number) => {
    if (!hasMultipleSubchats || interactionsDisabled || index < 0 || index >= subchatCount) {
      return;
    }
    subchatIndexStore.set(index);
  };

  const persistedSubchatOptions = createSubchatOptions(subchats);
  const fallbackSubchatLabel = getSubchatLabel(currentSubchatIndex);
  const subchatOptions = persistedSubchatOptions.some((option) => option.value === currentSubchatIndex)
    ? persistedSubchatOptions
    : [
        ...persistedSubchatOptions,
        {
          label: fallbackSubchatLabel,
          value: currentSubchatIndex,
        },
      ];
  const visibleSubchatOptions = [...subchatOptions].reverse();
  const currentSubchat = subchatOptions.find((option) => option.value === currentSubchatIndex);
  const currentSubchatLabel = currentSubchat?.label ?? fallbackSubchatLabel;
  const chatPositionLabel = `Chat ${currentSubchatIndex + 1} of ${subchatCount}`;
  const openRenameModal = () => {
    setRenameDialog({ context: interactionContext, token: Symbol('rename-dialog'), value: currentSubchatLabel });
  };
  const chatTitle = userId ? (
    <button
      type="button"
      className="group flex min-w-0 grow items-center gap-1.5 rounded-md bg-transparent text-left text-sm font-medium text-content-primary outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-50"
      title={`${currentSubchatLabel} — click to rename`}
      aria-label={`Rename current chat: ${currentSubchatLabel}`}
      disabled={!isSubchatLoaded || isRenaming}
      onClick={openRenameModal}
    >
      <span className="min-w-0 truncate">{currentSubchatLabel}</span>
      <Pencil1Icon
        className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        aria-hidden
      />
    </button>
  ) : (
    <span className="min-w-0 grow truncate text-sm font-medium text-content-primary" title={currentSubchatLabel}>
      {currentSubchatLabel}
    </span>
  );

  return (
    <nav aria-label="Chat history" className="mb-2 w-full px-4 pt-3 lg:px-6">
      <SubchatDialogs
        createOpen={activeCreateDialog !== null}
        renameOpen={activeRenameDialog !== null}
        renameValue={activeRenameDialog?.value ?? ''}
        renamePending={activeRenameDialog !== null && activeRenameDialog.token === activeRenameToken}
        renameDisabled={!activeRenameDialog?.value.trim() || isRenaming}
        createDisabled={interactionsDisabled}
        closeCreate={() => {
          if (!isCreatingSubchat) {
            const dialogToken = activeCreateDialog?.token;
            setCreateDialog((current) =>
              current?.context === interactionContext && current.token === dialogToken ? null : current,
            );
          }
        }}
        closeRename={() => {
          if (!isRenaming) {
            const dialogToken = activeRenameDialog?.token;
            setRenameDialog((current) =>
              current?.context === interactionContext && current.token === dialogToken ? null : current,
            );
          }
        }}
        setRenameValue={(value) => {
          const dialogToken = activeRenameDialog?.token;
          setRenameDialog((current) =>
            current?.context === interactionContext && current.token === dialogToken ? { ...current, value } : current,
          );
        }}
        createPending={activeCreateDialog !== null && activeCreateDialog.token === activeCreateToken}
        confirmCreate={async () => {
          if (interactionsDisabled || !activeCreateDialog) {
            return;
          }
          const { context, token } = activeCreateDialog;
          setPendingCreates((current) => new Map(current).set(context, token));
          try {
            if (await handleCreateSubchat()) {
              setCreateDialog((current) => (current?.context === context && current.token === token ? null : current));
            }
          } finally {
            setPendingCreates((current) => {
              if (current.get(context) !== token) {
                return current;
              }
              const next = new Map(current);
              next.delete(context);
              return next;
            });
          }
        }}
        confirmRename={async () => {
          if (!userId || !activeRenameDialog || isRenaming || activeRenameDialog.context !== interactionContext) {
            return;
          }
          const title = activeRenameDialog.value.trim();
          if (!title) {
            return;
          }
          const { context, token } = activeRenameDialog;
          setPendingRenames((current) => new Map(current).set(context, token));
          try {
            if (await handleRenameSubchat(title)) {
              setRenameDialog((current) => (current?.context === context && current.token === token ? null : current));
            }
          } finally {
            setPendingRenames((current) => {
              if (current.get(context) !== token) {
                return current;
              }
              const next = new Map(current);
              next.delete(context);
              return next;
            });
          }
        }}
      />
      <div className="border-content-secondary/15 flex items-center gap-2 border-b px-1 pb-2.5">
        {hasMultipleSubchats && (
          <div className="bg-background-secondary hidden shrink-0 rounded-lg sm:flex border border-bolt-elements-borderColor">
            <Button
              size="sm"
              variant="neutral"
              className="!size-11 !min-h-11 rounded-r-none border-0 !px-0"
              icon={<ArrowLeftIcon />}
              inline
              aria-label="Previous chat"
              tip={busyTip ?? 'Previous chat'}
              disabled={!canNavigatePrev || interactionsDisabled}
              onClick={() => {
                handleNavigateToSubchat(currentSubchatIndex - 1);
              }}
            />
            <Button
              size="sm"
              variant="neutral"
              className="!size-11 !min-h-11 rounded-l-none border-0 border-l border-l-bolt-elements-borderColor !px-0"
              icon={<ArrowRightIcon />}
              inline
              aria-label="Next chat"
              tip={busyTip ?? 'Next chat'}
              disabled={!canNavigateNext || interactionsDisabled}
              onClick={() => {
                handleNavigateToSubchat(currentSubchatIndex + 1);
              }}
            />
          </div>
        )}

        <div className="min-w-0 grow">
          {hasMultipleSubchats ? (
            <DropdownMenu.Root>
              <div className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3">
                <ChatBubbleIcon className="size-4 shrink-0 text-content-secondary" />
                {chatTitle}
                <DropdownMenu.Trigger asChild disabled={interactionsDisabled}>
                  <button
                    type="button"
                    className="group flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-content-secondary outline-none transition-colors hover:bg-bolt-elements-background-depth-2 focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={`Switch chat. ${chatPositionLabel}: ${currentSubchatLabel}`}
                  >
                    <span>
                      {currentSubchatIndex + 1}/{subchatCount}
                    </span>
                    <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                  </button>
                </DropdownMenu.Trigger>
              </div>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={8}
                  collisionPadding={12}
                  className="z-50 max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-1.5 text-content-primary shadow-panel outline-none"
                  aria-label="Chat history"
                >
                  <DropdownMenu.Label className="px-3 pb-2 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-content-secondary">
                    Chat history
                  </DropdownMenu.Label>
                  <DropdownMenu.RadioGroup
                    value={String(currentSubchatIndex)}
                    onValueChange={(value) => {
                      const subchatIndex = Number(value);
                      if (Number.isInteger(subchatIndex)) {
                        handleNavigateToSubchat(subchatIndex);
                      }
                    }}
                  >
                    {visibleSubchatOptions.map((option) => {
                      const isCurrent = option.value === currentSubchatIndex;
                      return (
                        <DropdownMenu.RadioItem
                          key={String(option.value)}
                          value={String(option.value)}
                          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors hover:bg-bolt-elements-background-depth-2 focus:bg-bolt-elements-background-depth-2 data-[state=checked]:bg-bolt-elements-background-depth-2"
                        >
                          <span className="flex size-7 shrink-0 items-center justify-center rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-xs font-semibold text-content-secondary">
                            {option.value + 1}
                          </span>
                          <span className="min-w-0 grow">
                            <span className="block truncate text-sm font-medium" title={option.label}>
                              {option.label}
                            </span>
                          </span>
                          {isCurrent && <CheckIcon className="size-4 shrink-0 text-accent-500" />}
                        </DropdownMenu.RadioItem>
                      );
                    })}
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : (
            <div className="flex min-h-11 min-w-0 items-center gap-3 px-2">
              <ChatBubbleIcon className="size-4 shrink-0 text-content-secondary" />
              {chatTitle}
            </div>
          )}
        </div>

        {!isSubchatLoaded && <Spinner />}

        <div className="flex shrink-0 items-center">
          {canCreateSubchat && (
            <Button
              size="sm"
              variant="neutral"
              className="!min-h-11 rounded-lg !px-3"
              icon={<PlusIcon />}
              disabled={chatDisabled || interactionsDisabled}
              inline
              aria-label="Start a new chat"
              tip={busyTip ?? (chatDisabled ? 'New chat unavailable' : 'Start a new chat with fresh context')}
              onClick={() => {
                setCreateDialog({ context: interactionContext, token: Symbol('create-dialog') });
              }}
            >
              <span className="hidden sm:inline">New chat</span>
            </Button>
          )}
        </div>
      </div>
    </nav>
  );
}
