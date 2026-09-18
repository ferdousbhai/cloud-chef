import { FileIcon } from '@radix-ui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useState } from 'react';
import { getToolInvocation, type CloudChefPart, type CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import type { PartId } from 'cloudchef-agent/partId';
import { toolResultSucceeded } from 'cloudchef-agent/tool-result';
import { ExpandableToolCard } from './ExpandableToolCard';
import { ToolCall } from './ToolCall';
import { invocationStatus, toolActivityStore } from '~/lib/stores/tool-activity.client';
import { statusIcon } from './tool-call-presentation';

/** File tools worth folding into one row when they arrive back-to-back. */
const GROUPABLE_FILE_TOOL_NAMES = new Set(['read', 'write', 'edit']);

export type FileGroupItem = { part: CloudChefPart; index: number; invocation: CloudChefToolInvocation };

export type MessageBlock =
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
    if (invocation !== null && GROUPABLE_FILE_TOOL_NAMES.has(invocation.toolName)) {
      run.push({ part, index, invocation });
      return;
    }
    flushRun();
    blocks.push({ kind: 'single', part, index });
  });
  flushRun();
  return blocks;
}

const GROUP_VERBS: Record<string, string> = { read: 'read', write: 'wrote', edit: 'edited' };

/** Plain-verb summary in first-appearance order, e.g. "Read 1 file, edited 2 files". */
export function describeFileGroup(invocations: CloudChefToolInvocation[]): string {
  const counts = new Map<string, number>();
  for (const invocation of invocations) {
    if (!GROUPABLE_FILE_TOOL_NAMES.has(invocation.toolName)) {
      continue;
    }
    counts.set(invocation.toolName, (counts.get(invocation.toolName) ?? 0) + 1);
  }
  const summary = [...counts]
    .map(([toolName, count]) => {
      const verb = GROUP_VERBS[toolName] ?? toolName;
      return `${verb} ${count} file${count === 1 ? '' : 's'}`;
    })
    .join(', ');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

function isErrorInvocation(invocation: CloudChefToolInvocation): boolean {
  return (
    invocation.state === 'output-error' ||
    invocation.state === 'output-denied' ||
    (invocation.state === 'output-available' && !toolResultSucceeded(invocation.output))
  );
}

export const FileToolGroup = memo(function FileToolGroup({
  entries,
}: {
  entries: Array<{ invocation: CloudChefToolInvocation; partId: PartId }>;
}) {
  const activities = useStore(toolActivityStore.activities);
  const statuses = entries.map(({ invocation, partId }) => activities[partId]?.status ?? invocationStatus(invocation));
  const aggregate = statuses.includes('running') ? 'running' : statuses.includes('pending') ? 'pending' : 'complete';
  const [showAll, setShowAll] = useState(false);
  const expanded = showAll || aggregate === 'pending' || aggregate === 'running';
  const invocations = entries.map((entry) => entry.invocation);
  const errored = invocations.find((invocation) => isErrorInvocation(invocation));

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
          {statusIcon(aggregate, errored ?? invocations[0])}
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
