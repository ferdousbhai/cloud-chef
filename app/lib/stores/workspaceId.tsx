/* A chat's immutable initial ID is its route, persistence, and agent identity. */
import { useNavigate, useParams, type HistoryState } from '@tanstack/react-router';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { map } from 'nanostores';

const logger = createScopedLogger('ChatId');
const WorkspaceIdContext = createContext<string | null>(null);

export function WorkspaceIdProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  return <WorkspaceIdContext.Provider value={workspaceId}>{children}</WorkspaceIdContext.Provider>;
}

export function useWorkspaceId() {
  const workspaceId = useContext(WorkspaceIdContext);
  if (!workspaceId) {
    throw new Error('useWorkspaceId must be used inside a WorkspaceIdProvider');
  }
  return workspaceId;
}

export function chatUrlMask(workspaceId: string) {
  return {
    to: '/chat/$id',
    params: { id: workspaceId },
    unmaskOnReload: true,
  } as const;
}

export function maskedChatNavigation(workspaceId: string) {
  return {
    to: '/' as const,
    state: (previous: HistoryState) => ({
      ...previous,
      cloudchefChatMaskId: workspaceId,
    }),
    mask: chatUrlMask(workspaceId),
    replace: true,
    resetScroll: false,
    ignoreBlocker: true,
  };
}

/**
 * Keep the live homepage build mounted while publishing its resumable URL.
 * Reloading the masked URL enters the existing-project route.
 */
export function useNavigateToChat() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const currentChatRouteId = params.id;

  return useCallback(
    async (workspaceId: string): Promise<void> => {
      try {
        if (currentChatRouteId === workspaceId) {
          return;
        }

        if (currentChatRouteId) {
          await navigate({
            to: '/chat/$id',
            params: { id: workspaceId },
            replace: true,
            resetScroll: false,
            ignoreBlocker: true,
          });
          return;
        }

        await navigate(maskedChatNavigation(workspaceId));
      } catch (error) {
        logger.warn('Unable to publish the resumable chat URL', error);
      }
    },
    [currentChatRouteId, navigate],
  );
}

export const chatStore = map({
  started: false,
  aborted: false,
  showChat: true,
});
