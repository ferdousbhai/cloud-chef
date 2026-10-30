import type { ConversationSummary } from '~/lib/cloudflare/data-api';

export type { ConversationSummary };

interface SubchatOption {
  label: string;
  value: number;
}

export interface LiveSubchatTitle {
  conversationIndex: number;
  title: string;
}

export function getSubchatLabel(conversationIndex: number, description?: string): string {
  const normalizedDescription = description?.trim();
  return normalizedDescription || (conversationIndex === 0 ? 'Initial chat' : `Chat ${conversationIndex + 1}`);
}

export function createSubchatOptions(subchats: ConversationSummary[] | undefined): SubchatOption[] {
  return (
    subchats?.map((subchat) => ({
      label: getSubchatLabel(subchat.conversationIndex, subchat.description),
      value: subchat.conversationIndex,
    })) ?? []
  );
}

export function getSubchatNavigation(subchatCount: number, currentSubchatIndex: number, hasSession: boolean) {
  const latestSubchatIndex = subchatCount - 1;
  const hasMultipleSubchats = subchatCount > 1;
  return {
    canCreateSubchat: currentSubchatIndex >= latestSubchatIndex && hasSession,
    canNavigateNext: hasMultipleSubchats && currentSubchatIndex < latestSubchatIndex,
    canNavigatePrev: hasMultipleSubchats && currentSubchatIndex > 0,
    hasMultipleSubchats,
  };
}

export function applyLiveSubchatTitle(
  subchats: ConversationSummary[] | undefined,
  liveTitle: LiveSubchatTitle | null,
  transcript: ConversationSummary['transcript'],
): ConversationSummary[] | undefined {
  if (!liveTitle) {
    return subchats;
  }

  if (!subchats) {
    return [
      {
        conversationIndex: liveTitle.conversationIndex,
        description: liveTitle.title,
        updatedAt: Date.now(),
        transcript,
      },
    ];
  }

  const persisted = subchats.find((subchat) => subchat.conversationIndex === liveTitle.conversationIndex);
  if (persisted?.description?.trim()) {
    return subchats;
  }

  if (!persisted) {
    return [
      ...subchats,
      {
        conversationIndex: liveTitle.conversationIndex,
        description: liveTitle.title,
        updatedAt: Date.now(),
        transcript,
      },
    ];
  }

  return subchats.map((subchat) =>
    subchat.conversationIndex === liveTitle.conversationIndex ? { ...subchat, description: liveTitle.title } : subchat,
  );
}
