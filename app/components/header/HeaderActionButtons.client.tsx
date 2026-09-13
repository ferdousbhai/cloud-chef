import { useStore } from '@nanostores/react';
import { ChatBubbleIcon, CodeIcon, EyeOpenIcon } from '@radix-ui/react-icons';
import { useEffect, type ReactNode } from 'react';
import { Button } from '@ui/Button';
import useViewport from '~/lib/hooks/useViewport';
import { chatStore } from '~/lib/stores/chatId';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { selectWorkspaceSurface } from '~/lib/stores/workspace-surface.client';
import { classNames } from '~/utils/classNames';

export function HeaderActionButtons() {
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const { showChat } = useStore(chatStore);
  const isSmallViewport = useViewport(1024);
  const canHideChat = showWorkbench || !showChat;

  if (isSmallViewport) {
    return <SmallScreenSurfaceSwitcher showChat={showChat} showWorkbench={showWorkbench} />;
  }

  return (
    <div className="flex">
      <div className="flex overflow-hidden">
        <Button
          disabled={!canHideChat}
          tip={!canHideChat ? 'Cannot hide chat while code is closed' : showChat ? 'Hide chat' : 'Show chat'}
          onClick={() => chatStore.setKey('showChat', !showChat)}
          variant="neutral"
          className="!size-11 !min-h-11 rounded-r-none border-r-0 !px-0 sm:!size-auto sm:!min-h-9 sm:!px-3"
          icon={<ChatBubbleIcon className="my-px" />}
          aria-label={showChat ? 'Hide chat' : 'Show chat'}
        />
        <Button
          onClick={() => {
            if (showWorkbench && !showChat) {
              chatStore.setKey('showChat', true);
            }

            workbenchStore.showWorkbench.set(!showWorkbench);
          }}
          variant="neutral"
          className="!size-11 !min-h-11 rounded-l-none !px-0 sm:!size-auto sm:!min-h-9 sm:!px-3"
          icon={<CodeIcon className="my-px" />}
          aria-label={showWorkbench ? 'Hide workbench' : 'Show workbench'}
          tip={showWorkbench ? 'Hide workbench' : 'Show workbench'}
        />
      </div>
    </div>
  );
}

function SmallScreenSurfaceSwitcher({ showChat, showWorkbench }: { showChat: boolean; showWorkbench: boolean }) {
  const selectedView = useStore(workbenchStore.currentView);

  useEffect(() => {
    if (!showChat && !showWorkbench) {
      chatStore.setKey('showChat', true);
    }
  }, [showChat, showWorkbench]);

  return (
    <div
      className="flex overflow-hidden rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2"
      role="group"
      aria-label="Workspace view"
    >
      <SurfaceButton
        label="Chat"
        selected={showChat && !showWorkbench}
        icon={<ChatBubbleIcon />}
        onClick={() => {
          selectWorkspaceSurface('chat');
        }}
      />
      <SurfaceButton
        label="Code"
        selected={showWorkbench && selectedView === 'code'}
        icon={<CodeIcon />}
        onClick={() => selectWorkspaceSurface('code')}
      />
      <SurfaceButton
        label="Preview"
        selected={showWorkbench && selectedView === 'preview'}
        icon={<EyeOpenIcon />}
        onClick={() => selectWorkspaceSurface('preview')}
      />
    </div>
  );
}

function SurfaceButton({
  label,
  selected,
  icon,
  onClick,
}: {
  label: string;
  selected: boolean;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={classNames(
        'grid size-11 shrink-0 place-items-center border-r border-bolt-elements-borderColor text-content-secondary transition-colors last:border-r-0 hover:bg-bolt-elements-background-depth-3 hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500',
        {
          'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent': selected,
        },
      )}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
