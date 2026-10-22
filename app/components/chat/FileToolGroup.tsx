import { FileIcon } from '@radix-ui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useState } from 'react';
import { getToolInvocation, type CloudChefPart, type CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import type { PartId } from 'cloudchef-agent/partId';
import { ExpandableToolCard } from './ExpandableToolCard';
import { ToolCall } from './ToolCall';
import { partStatus, toolActivityStore } from '~/lib/stores/tool-activity.client';
import { isErrorResult, statusIcon } from './tool-call-presentation';
import { isToolActivityStatusActive } from '~/lib/common/types';

/** File tools worth folding into one row when they arrive back-to-back, and the verb each is summarised with. */
const GROUP_VERBS = new Map([
  ['read', 'read'],
  ['write', 'wrote'],
  ['edit', 'edited'],
]);

type FileGroupItem = { part: CloudChefPart; index: number; invocation: CloudChefToolInvocation };

type MessageBlock =
  { kind: 'single'; part: CloudChefPart; index: number } | { kind: 'file-group'; items: FileGroupItem[] };

/** Fold runs of 2+ consecutive file tools into one block; everything else stays single. */
export function groupMessageParts(parts: CloudChefPart[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let run: FileGroupItem[] = [];
  const flushRun = () => {
    if (run.length >= 2) {
      blocks.push({ kind: 'file-group', items: run });
    } else {
      for (const item of run) {
        blocks.push({ kind: 'single', part: item.part, index: item.index });
      }
    }
    run = [];
  };
  parts.forEach((part, index) => {
    const invocation = getToolInvocation(part);
    if (invocation !== null && GROUP_VERBS.has(invocation.toolName)) {
      run.push({ part, index, invocation });
      return;
    }
    flushRun();
    blocks.push({ kind: 'single', part, index });
  });
  flushRun();
  return blocks;
}

/** Plain-verb summary in first-appearance order, e.g. "Read 1 file, edited 2 files". */
export function describeFileGroup(invocations: CloudChefToolInvocation[]): string {
  const counts = new Map<string, number>();
  for (const invocation of invocations) {
    counts.set(invocation.toolName, (counts.get(invocation.toolName) ?? 0) + 1);
  }
  const summary = [...counts]
    .map(([toolName, count]) => {
      const verb = GROUP_VERBS.get(toolName);
      return `${verb} ${count} file${count === 1 ? '' : 's'}`;
    })
    .join(', ');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

export const FileToolGroup = memo(function FileToolGroup({
  entries,
}: {
  entries: Array<{ invocation: CloudChefToolInvocation; partId: PartId }>;
}) {
  const activities = useStore(toolActivityStore.activities);
  const statuses = entries.map(({ invocation, partId }) => partStatus(activities, partId, invocation));
  const aggregate = statuses.includes('running') ? 'running' : statuses.includes('pending') ? 'pending' : 'complete';
  const [showAll, setShowAll] = useState(false);
  const expanded = showAll || isToolActivityStatusActive(aggregate);
  const invocations = entries.map((entry) => entry.invocation);
  const errored = invocations.find(isErrorResult);

  return (
    <ExpandableToolCard
      expanded={expanded}
      onToggle={() => setShowAll((visible) => !visible)}
      header={
        <div className="flex items-center gap-1.5">
          <div className="flex w-full items-center gap-1.5 text-[13px] font-medium leading-4 text-content-primary">
            <FileIcon className="shrink-0 text-content-secondary" />
            <span className="truncate">{describeFileGroup(invocations)}</span>
          </div>
          {/* File tools are never a GitHub publish. */}
          {statusIcon(aggregate, errored ?? invocations[0], null)}
        </div>
      }
      body={
        <div className="flex flex-col gap-1">
          {entries.map(({ invocation, partId }) => (
            <ToolCall key={partId} partId={partId} invocation={invocation} />
          ))}
        </div>
      }
    />
  );
});
