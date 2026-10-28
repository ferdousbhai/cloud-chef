import { USER_WORKSPACE_RUNTIME_GC_CRON } from '../../app/lib/.server/cloudflare/user-workspace-runtime-policy';
import { sweepAgentGcCandidatesBestEffort } from '../../app/lib/cloudflare/data/agent-gc.server';
import { sweepAppResourceGcCandidatesBestEffort } from '../../app/lib/cloudflare/data/app-resource-gc.server';
import { sweepCloneTokensBestEffort } from '../../app/lib/cloudflare/data/clone-tokens.server';

type RuntimeMaintenanceEnv = Parameters<typeof sweepAppResourceGcCandidatesBestEffort>[0] &
  Parameters<typeof sweepCloneTokensBestEffort>[0] &
  Pick<Env, 'ConversationAgent'>;

/** Register the sole user-runtime maintenance job only for its provisioned trigger. */
export function scheduleUserWorkspaceRuntimeMaintenance(
  controller: Pick<ScheduledController, 'cron'>,
  env: RuntimeMaintenanceEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): void {
  if (controller.cron !== USER_WORKSPACE_RUNTIME_GC_CRON) {
    return;
  }
  ctx.waitUntil(sweepAgentGcCandidatesBestEffort(env));
  ctx.waitUntil(sweepAppResourceGcCandidatesBestEffort(env, { requeueRemovedChats: true }));
  ctx.waitUntil(sweepCloneTokensBestEffort(env));
}
