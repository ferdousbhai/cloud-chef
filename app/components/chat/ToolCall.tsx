import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useMemo, useState } from 'react';
import type { CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import type { PartId } from 'cloudchef-agent/partId';
import { ToolUseContents } from './ToolUseContents';
import { normalizeToolInvocation, statusIcon, toolTitle } from './tool-call-presentation';
import { ExpandableToolCard } from './ExpandableToolCard';
import { invocationStatus, toolActivityStore } from '~/lib/stores/tool-activity.client';
import { toolProgressStore } from '~/lib/stores/tool-progress.client';
import type {
  CloudflareExecutionDecisionHandler,
  CloudflareExecutionPublicState,
} from 'cloudchef-agent/cloudflare-mcp';

export const ToolCall = memo(function ToolCall({
  partId,
  invocation: rawInvocation,
  cloudflareExecutions,
  onCloudflareExecutionDecision,
}: {
  partId: PartId;
  invocation: CloudChefToolInvocation;
  cloudflareExecutions?: readonly CloudflareExecutionPublicState[];
  onCloudflareExecutionDecision?: CloudflareExecutionDecisionHandler;
}) {
  const activities = useStore(toolActivityStore.activities);
  const progress = useStore(toolProgressStore.progress)[rawInvocation.toolCallId]?.result;
  const [showAction, setShowAction] = useState(false);
  const activity = activities[partId];
  const invocation = useMemo(
    () => normalizeToolInvocation(activity?.invocation ?? rawInvocation),
    [activity?.invocation, rawInvocation],
  );
  const status = activity?.status ?? invocationStatus(invocation);
  const cloudflareExecution = cloudflareExecutions?.find((execution) => execution.toolCallId === invocation.toolCallId);
  const expanded =
    showAction || status === 'pending' || status === 'running' || cloudflareExecution?.status === 'awaiting_approval';

  const toggleAction = () => {
    setShowAction((visible) => !visible);
  };

  return (
    <ExpandableToolCard
      expanded={expanded}
      header={
        <div className="flex items-center gap-1.5">
          <div className="w-full text-[13px] font-medium leading-4 text-content-primary">
            {toolTitle(invocation, status)}
          </div>
          {statusIcon(status, invocation)}
        </div>
      }
      onToggle={toggleAction}
      body={
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="space-y-1.5">
            <ToolUseContents
              invocation={invocation}
              status={status}
              progress={progress}
              cloudflareExecution={cloudflareExecution}
              onCloudflareExecutionDecision={onCloudflareExecutionDecision}
            />
          </div>
        </motion.div>
      }
    />
  );
});
