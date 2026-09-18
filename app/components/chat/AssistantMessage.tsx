import { lazy, memo, Suspense, useEffect, useRef } from 'react';
import { ToolCall } from './ToolCall';
import { FileToolGroup, groupMessageParts } from './FileToolGroup';
import { ReasoningPart } from './ReasoningPart';
import { makePartId, type PartId } from 'ghostbuild-agent/partId.js';
import { getToolInvocation, type GhostbuildMessage, type GhostbuildPart } from 'ghostbuild-agent/ai-compat';
import { captureMessage } from '~/lib/telemetry.client';
import type {
  CloudflareExecutionDecisionHandler,
  CloudflareExecutionPublicState,
} from 'ghostbuild-agent/cloudflare-mcp';

const Markdown = lazy(() => import('./Markdown').then((module) => ({ default: module.Markdown })));

interface AssistantMessageProps {
  message: GhostbuildMessage;
  cloudflareExecutions?: readonly CloudflareExecutionPublicState[];
  onCloudflareExecutionDecision?: CloudflareExecutionDecisionHandler;
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  cloudflareExecutions,
  onCloudflareExecutionDecision,
}: AssistantMessageProps) {
  return (
    <div className="w-full overflow-hidden text-[13px] leading-6">
      <div className="flex flex-col gap-1">
        {groupMessageParts(message.parts).map((block) =>
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
  partId,
  cloudflareExecutions,
  onCloudflareExecutionDecision,
}: {
  part: GhostbuildPart;
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

  if (part.type === 'text') {
    return typeof part.text === 'string' ? (
      <Suspense fallback={null}>
        <Markdown>{part.text}</Markdown>
      </Suspense>
    ) : null;
  }

  if (part.type === 'reasoning') {
    return <ReasoningPart part={part} />;
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
