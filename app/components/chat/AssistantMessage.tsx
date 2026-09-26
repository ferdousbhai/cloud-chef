import { memo, useEffect, useRef } from 'react';
import { ToolCall } from './ToolCall';
import { FileToolGroup, groupMessageParts } from './FileToolGroup';
import { ReasoningPart } from './ReasoningPart';
import { makePartId, type PartId } from 'cloudchef-agent/partId.js';
import { getToolInvocation, type CloudChefMessage, type CloudChefPart } from 'cloudchef-agent/ai-compat';
import { captureMessage } from '~/lib/telemetry.client';
import type {
  CloudflareExecutionDecisionHandler,
  CloudflareExecutionPublicState,
} from 'cloudchef-agent/cloudflare-mcp';

interface AssistantMessageProps {
  message: CloudChefMessage;
  isStreaming?: boolean;
  startIndex?: number;
  endIndex?: number;
  /** A reveal request for the part streaming now; see ActivityPanel. */
  revealKey?: number;
  cloudflareExecutions?: readonly CloudflareExecutionPublicState[];
  onCloudflareExecutionDecision?: CloudflareExecutionDecisionHandler;
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  isStreaming = false,
  startIndex = 0,
  endIndex = message.parts.length,
  revealKey = 0,
  cloudflareExecutions,
  onCloudflareExecutionDecision,
}: AssistantMessageProps) {
  return (
    <div className="w-full overflow-hidden text-[13px] leading-6">
      <div className="flex flex-col gap-1">
        {groupMessageParts(message.parts)
          .filter((block) => {
            const index = block.kind === 'single' ? block.index : block.items[0].index;
            return index >= startIndex && index < endIndex && (block.kind !== 'single' || block.part.type !== 'text');
          })
          .map((block) =>
            block.kind === 'file-group' ? (
              <FileToolGroup
                key={block.items[0].index}
                entries={block.items.map((item) => ({
                  invocation: item.invocation,
                  partId: makePartId(message.id, item.index),
                }))}
              />
            ) : (
              <AssistantMessagePart
                key={block.index}
                part={block.part}
                isStreaming={isStreaming && block.index === message.parts.length - 1}
                revealKey={isStreaming && block.index === message.parts.length - 1 ? revealKey : 0}
                partId={makePartId(message.id, block.index)}
                cloudflareExecutions={cloudflareExecutions}
                onCloudflareExecutionDecision={onCloudflareExecutionDecision}
              />
            ),
          )}
      </div>
    </div>
  );
});

function AssistantMessagePart({
  part,
  isStreaming,
  revealKey,
  partId,
  cloudflareExecutions,
  onCloudflareExecutionDecision,
}: {
  part: CloudChefPart;
  isStreaming: boolean;
  revealKey: number;
  partId: PartId;
  cloudflareExecutions?: readonly CloudflareExecutionPublicState[];
  onCloudflareExecutionDecision?: CloudflareExecutionDecisionHandler;
}) {
  const toolInvocation = getToolInvocation(part);
  if (toolInvocation) {
    return (
      <ToolCall
        partId={partId}
        invocation={toolInvocation}
        cloudflareExecutions={cloudflareExecutions}
        onCloudflareExecutionDecision={onCloudflareExecutionDecision}
      />
    );
  }

  if (part.type === 'reasoning') {
    return <ReasoningPart part={part} isActive={isStreaming} revealKey={revealKey} />;
  }

  if (part.type === 'step-start' || part.type === 'reasoning-file') {
    return null;
  }

  return <UnknownAssistantMessagePart partId={partId} />;
}

function UnknownAssistantMessagePart({ partId }: { partId: PartId }) {
  const capturedPartIdRef = useRef<PartId | null>(null);

  useEffect(() => {
    if (capturedPartIdRef.current === partId) {
      return;
    }
    capturedPartIdRef.current = partId;
    captureMessage('Unknown assistant message part');
  }, [partId]);

  return null;
}
