import { useEffect, useMemo, useState } from 'react';
import { getToolInvocation, type CloudChefMessage } from 'cloudchef-agent/ai-compat';
import type { StreamStatus } from '~/lib/common/types';
import { getBuildProgress } from './build-progress';
import { streamedToolInput } from './streaming-tool-input';
import { reasoningPartView } from './ReasoningPart';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';

const CLOCK_INTERVAL_MS = 1_000;

/** The reasoning part the model is streaming right now, and when this client first saw it. */
type ReasoningActivity = {
  key: string;
  startedAt: number;
};

export function useBuildProgress(args: {
  streamStatus: StreamStatus;
  isRecovering: boolean;
  isProjectUpdate: boolean;
  activeToolNames: string[];
  validationStage: BuilderValidationStage | null;
  toolActivityRevision: number;
  toolProgressRevision: number;
  messages: CloudChefMessage[];
}) {
  const activeToolActivity = args.activeToolNames.toSorted().join(',');
  const activityKey = useMemo(
    () =>
      `${messageActivityKey(args.messages)}:${args.toolActivityRevision}:${args.toolProgressRevision}:${activeToolActivity}:${args.streamStatus}:${args.isRecovering}:${args.isProjectUpdate}:${args.validationStage ?? ''}`,
    [
      activeToolActivity,
      args.isProjectUpdate,
      args.isRecovering,
      args.messages,
      args.streamStatus,
      args.toolActivityRevision,
      args.toolProgressRevision,
      args.validationStage,
    ],
  );
  const reasoningKey = useMemo(() => streamingReasoningKey(args.messages), [args.messages]);
  const [clock, setClock] = useState(() => {
    const timestamp = Date.now();
    return { activityKey, lastActivityAt: timestamp, now: timestamp };
  });
  const [reasoning, setReasoning] = useState<ReasoningActivity | null>(null);

  useEffect(() => {
    const timestamp = Date.now();
    setClock({ activityKey, lastActivityAt: timestamp, now: timestamp });
  }, [activityKey]);

  useEffect(() => {
    setReasoning((current) => {
      if (reasoningKey === null) {
        return null;
      }
      return current?.key === reasoningKey ? current : { key: reasoningKey, startedAt: Date.now() };
    });
  }, [reasoningKey]);

  const active = args.isRecovering || args.streamStatus === 'submitted' || args.streamStatus === 'streaming';
  useEffect(() => {
    if (!active) {
      return () => undefined;
    }
    const interval = window.setInterval(
      () => setClock((current) => (current.activityKey === activityKey ? { ...current, now: Date.now() } : current)),
      CLOCK_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [active, activityKey]);

  return getBuildProgress({
    streamStatus: args.streamStatus,
    isRecovering: args.isRecovering,
    isProjectUpdate: args.isProjectUpdate,
    activeToolNames: args.activeToolNames,
    validationStage: args.validationStage,
    reasoningForMs:
      reasoning !== null && reasoning.key === reasoningKey ? Math.max(0, clock.now - reasoning.startedAt) : null,
    inactiveForMs: clock.activityKey === activityKey ? Math.max(0, clock.now - clock.lastActivityAt) : 0,
  });
}

/**
 * Everything the assistant is producing right now: visible text, the reasoning behind it, and the
 * arguments of a tool call still being written. Any of them growing means the turn is alive, so the
 * quiet clock restarts and the user is never told there is "no new update" while tokens arrive.
 */
function messageActivityKey(messages: CloudChefMessage[]): string {
  const lastMessage = messages.at(-1);
  if (!lastMessage) {
    return 'empty';
  }
  const partActivity =
    lastMessage.parts
      ?.map((part) => {
        if (part.type === 'text') {
          return `text:${typeof part.text === 'string' ? part.text.length : 0}`;
        }
        if (part.type === 'reasoning') {
          const reasoning = reasoningPartView(part);
          return `reasoning:${reasoning.text.length}:${reasoning.streaming}`;
        }
        const invocation = getToolInvocation(part);
        if (!invocation) {
          return part.type;
        }
        const streamedInput =
          invocation.state === 'input-streaming' ? `:${streamedToolInput(invocation).characters}` : '';
        return `tool:${invocation.toolCallId}:${invocation.toolName}:${invocation.state}${streamedInput}`;
      })
      .join(',') ?? '';
  return `${messages.length}:${lastMessage.id}:${partActivity}`;
}

/** Identity of the reasoning part still streaming in the newest message, if the model is thinking. */
function streamingReasoningKey(messages: CloudChefMessage[]): string | null {
  const lastMessage = messages.at(-1);
  if (!lastMessage?.parts) {
    return null;
  }
  const index = lastMessage.parts.length - 1;
  const part = lastMessage.parts[index];
  return part?.type === 'reasoning' && reasoningPartView(part).streaming ? `${lastMessage.id}:${index}` : null;
}
