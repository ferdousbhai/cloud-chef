import type { SubchatSummary } from '~/lib/cloudflare/data-api';

export type { SubchatSummary };

export interface SubchatOption {
  label: string;
  value: number;
}

export interface LiveSubchatTitle {
  subchatIndex: number;
  title: string;
}

export function getSubchatLabel(subchatIndex: number, description?: string): string {
  const normalizedDescription = description?.trim();
  return normalizedDescription || (subchatIndex === 0 ? 'Initial chat' : `Chat ${subchatIndex + 1}`);
}

export function createSubchatOptions(subchats: SubchatSummary[] | undefined): SubchatOption[] {
  return (
    subchats?.map((subchat) => ({
      label: getSubchatLabel(subchat.subchatIndex, subchat.description),
      value: subchat.subchatIndex,
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
  subchats: SubchatSummary[] | undefined,
  liveTitle: LiveSubchatTitle | null,
  transcript: SubchatSummary['transcript'],
): SubchatSummary[] | undefined {
  if (!liveTitle) {
    return subchats;
  }

  if (!subchats) {
    return [
      {
        subchatIndex: liveTitle.subchatIndex,
        description: liveTitle.title,
        updatedAt: Date.now(),
        transcript,
      },
    ];
  }

  const persisted = subchats.find((subchat) => subchat.subchatIndex === liveTitle.subchatIndex);
  if (persisted?.description?.trim()) {
    return subchats;
  }

  if (!persisted) {
    return [
      ...subchats,
      {
        subchatIndex: liveTitle.subchatIndex,
        description: liveTitle.title,
        updatedAt: Date.now(),
        transcript,
      },
    ];
  }

  return subchats.map((subchat) =>
    subchat.subchatIndex === liveTitle.subchatIndex ? { ...subchat, description: liveTitle.title } : subchat,
  );
}
