import { useEffect, useId, useRef, useState } from 'react';
import { useStore } from '@nanostores/react';
import { z } from 'zod';
import { getToolInvocation, type CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { toolResultSucceeded } from 'cloudchef-agent/tool-result';
import type {
  CloudflareExecutionDecisionHandler,
  CloudflareExecutionPublicState,
} from 'cloudchef-agent/cloudflare-mcp';
import { activityRevealStore } from '~/lib/stores/activity-reveal';
import { AssistantMessage } from './AssistantMessage';
import { reasoningPartView } from './ReasoningPart';
import { DetailsToggle } from './DetailsToggle';
import styles from './BaseChat.module.css';

const filePathInput = z.object({ path: z.string() });

/** Keep the original messages and part offsets: tool progress is keyed by their durable IDs. */
export function ActivityPanel({
  messages,
  isStreaming,
  compact,
  cloudflareExecutions,
  onCloudflareExecutionDecision,
}: {
  messages: CloudChefMessage[];
  isStreaming: boolean;
  compact: boolean;
  cloudflareExecutions?: readonly CloudflareExecutionPublicState[];
  onCloudflareExecutionDecision?: CloudflareExecutionDecisionHandler;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  // Answer only reveals requested while this panel exists, not one left over from another chat.
  const [revealBaseline] = useState(() => activityRevealStore.get());
  const revealRequest = useStore(activityRevealStore);
  const revealKey = revealRequest > revealBaseline ? revealRequest : 0;
  useEffect(() => {
    if (revealKey) {
      setExpanded(true);
    }
  }, [revealKey]);
  const pendingApproval = cloudflareExecutions?.some((execution) => execution.status === 'awaiting_approval') ?? false;
  const visible = !compact || expanded || pendingApproval;
  const activity = messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.parts.some((part) => part.type === 'reasoning' || getToolInvocation(part)),
  );
  return (
    <aside className={styles.ActivityPanel} aria-label="Agent activity" data-compact={compact}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-bolt-elements-borderColor px-3 py-2">
        <h2 className="text-sm font-medium text-content-primary">Activity</h2>
        {compact ? (
          <DetailsToggle
            expanded={visible}
            controls={detailsId}
            onToggle={() => setExpanded(!expanded)}
            disabled={pendingApproval}
            suffix={isStreaming ? ' · Working' : ''}
          />
        ) : (
          <span className="text-xs text-content-tertiary">{isStreaming ? 'Working' : 'Latest first'}</span>
        )}
      </div>
      {visible && (
        <div id={detailsId} className={styles.ActivityList}>
          {activity.length === 0 ? (
            <p className="p-3 text-xs text-content-tertiary">Tool activity and reasoning will appear here.</p>
          ) : (
            activity
              .toReversed()
              .map((message) => (
                <ActivityRun
                  key={message.id}
                  message={message}
                  active={isStreaming && message === messages.at(-1)}
                  revealKey={revealKey}
                  cloudflareExecutions={cloudflareExecutions}
                  onCloudflareExecutionDecision={onCloudflareExecutionDecision}
                />
              ))
          )}
        </div>
      )}
    </aside>
  );
}

function ActivityRun({
  message,
  active,
  revealKey,
  cloudflareExecutions,
  onCloudflareExecutionDecision,
}: {
  message: CloudChefMessage;
  active: boolean;
  /** A reveal the status line requested; only the active run answers it. */
  revealKey: number;
  cloudflareExecutions?: readonly CloudflareExecutionPublicState[];
  onCloudflareExecutionDecision?: CloudflareExecutionDecisionHandler;
}) {
  const [expanded, setExpanded] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const lastPart = message.parts.at(-1);
  // Live reasoning answers a reveal itself (expand, scroll, highlight); otherwise the run scrolls.
  const reasoningLive = active && lastPart?.type === 'reasoning' && reasoningPartView(lastPart).streaming;
  const runRevealKey = active ? revealKey : 0;
  // Only a new request scrolls; the reasoning ending later must not pull the view back.
  const handledRevealRef = useRef(0);
  useEffect(() => {
    if (runRevealKey && runRevealKey !== handledRevealRef.current) {
      handledRevealRef.current = runRevealKey;
      if (!reasoningLive) {
        sectionRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [runRevealKey, reasoningLive]);
  const tools = message.parts.map(getToolInvocation).filter((tool) => tool !== null);
  const pendingApproval = tools.some((tool) =>
    cloudflareExecutions?.some(
      (execution) => execution.toolCallId === tool.toolCallId && execution.status === 'awaiting_approval',
    ),
  );
  const open = active || expanded || pendingApproval;
  const currentStepStart = Math.max(
    0,
    message.parts.findLastIndex((part) => part.type === 'reasoning' || part.type === 'text'),
  );
  const changedFiles = new Set(
    tools
      .filter(
        (tool) =>
          (tool.toolName === 'write' || tool.toolName === 'edit') &&
          tool.state === 'output-available' &&
          toolResultSucceeded(tool.output),
      )
      .flatMap((tool) => {
        const parsed = filePathInput.safeParse(tool.input);
        return parsed.success ? [parsed.data.path] : [];
      }),
  );
  const validation = tools.findLast(
    (tool) => tool.toolName === 'validate' && (tool.state === 'output-available' || tool.state === 'output-error'),
  );
  const summary = [
    `${tools.length} tool step${tools.length === 1 ? '' : 's'}`,
    ...(changedFiles.size ? [`${changedFiles.size} file${changedFiles.size === 1 ? '' : 's'} changed`] : []),
    ...(validation
      ? [
          validation.state === 'output-available' && toolResultSucceeded(validation.output)
            ? 'Validation passed'
            : 'Validation failed',
        ]
      : []),
  ].join(' · ');
  return (
    <section ref={sectionRef} className="min-w-0 border-b border-bolt-elements-borderColor last:border-0">
      <button
        type="button"
        className="w-full p-3 text-left text-xs text-content-secondary hover:text-content-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500"
        aria-expanded={open}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="block font-medium text-content-primary">
          {active ? 'Current work' : pendingApproval ? 'Approval needed' : 'Activity summary'}
        </span>
        <span className="mt-1 block">{summary}</span>
      </button>
      {open && (
        <div className="min-w-0 px-2 pb-3">
          {active && currentStepStart > 0 && !pendingApproval && (
            <details className="mb-2 text-xs text-content-secondary">
              <summary className="cursor-pointer py-2">Earlier steps</summary>
              <AssistantMessage
                message={message}
                endIndex={currentStepStart}
                cloudflareExecutions={cloudflareExecutions}
                onCloudflareExecutionDecision={onCloudflareExecutionDecision}
              />
            </details>
          )}
          <AssistantMessage
            message={message}
            startIndex={active && !pendingApproval ? currentStepStart : 0}
            isStreaming={active}
            revealKey={reasoningLive ? runRevealKey : 0}
            cloudflareExecutions={cloudflareExecutions}
            onCloudflareExecutionDecision={onCloudflareExecutionDecision}
          />
        </div>
      )}
    </section>
  );
}
