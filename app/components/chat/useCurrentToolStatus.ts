import { useStore } from '@nanostores/react';
import { useMemo } from 'react';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { makePartId } from 'cloudchef-agent/partId';
import { isToolActivityStatusActive } from '~/lib/common/types';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { toolProgressStore } from '~/lib/stores/tool-progress.client';

type ToolActivities = ReturnType<(typeof toolActivityStore.activities)['get']>;

export function useCurrentToolStatus(messages: CloudChefMessage[]): {
  activeToolNames: string[];
  activityRevision: number;
  progressRevision: number;
} {
  const activities = useStore(toolActivityStore.activities);
  const activityRevision = useStore(toolActivityStore.revision);
  const progressRevision = useStore(toolProgressStore.revision);
  return useMemo(
    () => ({ activeToolNames: currentToolStatus(messages, activities), activityRevision, progressRevision }),
    [activities, activityRevision, messages, progressRevision],
  );
}

export function currentToolStatus(messages: CloudChefMessage[], activities: ToolActivities) {
  const currentPartIds = new Set<string>();
  for (const message of messages) {
    message.parts?.forEach((_part, index) => currentPartIds.add(makePartId(message.id, index)));
  }
  const activeToolNames = new Set<string>();
  for (const [partId, activity] of Object.entries(activities)) {
    if (!currentPartIds.has(partId)) {
      continue;
    }
    if (isToolActivityStatusActive(activity.status) && activity.invocation.toolName) {
      activeToolNames.add(activity.invocation.toolName);
    }
  }
  return [...activeToolNames];
}
