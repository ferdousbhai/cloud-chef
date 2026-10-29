import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ConversationAgent } from '../../app/agents/conversation-agent';
import {
  readCloudflareApiRuntimeIdentity,
  runtimeConnectionIdentity,
} from '../../app/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import {
  cloudflareApiErrorBody,
  handleCloudflareApiProxyRequest,
  sendCloudflareRequest,
  type CloudflareAccountAccess,
} from '../../app/lib/.server/cloudflare/cloudflare-api-proxy';
import {
  fileTeamCloudflareChange,
  TEAM_FILED_ANSWER,
} from '../../app/lib/.server/cloudflare/team-cloudflare-approvals';
import {
  confirmUserWorkspaceAccess,
  resolveUserWorkspaceCloudflareAccessToken,
} from '../../app/lib/.server/cloudflare/user-workspace-cloudflare-credential';
import { abortableSleep } from '../../app/lib/abortable-sleep';
import type { ProjectWorkspace } from './index';

type CloudflareApiProxyEnv = Pick<
  Env,
  | 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT'
  | 'CONTROL_PLANE_SECRET'
  | 'CLOUDCHEF_USER_ID'
  | 'CLOUDFLARE_ACCOUNT_ID'
  | 'CLOUDCHEF_CONNECTION_ID'
  | 'CLOUDCHEF_CONNECTION_GENERATION'
  | 'CLOUDCHEF_USER_RUNTIME'
  | 'CLOUDCHEF_SHARED_ACCOUNT'
> & {
  PROJECT_WORKSPACE: DurableObjectNamespace<ProjectWorkspace>;
  ConversationAgent: DurableObjectNamespace<ConversationAgent>;
};

const NOT_CONNECTED = 'This workspace is not connected to CloudChef.';

/**
 * Minted for one workspace by its ProjectWorkspace, as the handler for cloudflare-api.internal in its container:
 * reads go to Cloudflare with the account's authorization; a change goes to the agent whose command asked, which
 * holds `cf` until the person decides (within the command's time; after it the change waits in the chat), or, with no agent command running, is the person's own from the terminal and
 * is sent at once (a team member's, from either, goes to the team's admins).
 */
export class CloudflareApiProxy extends WorkerEntrypoint<CloudflareApiProxyEnv, { workspaceId: string }> {
  override fetch(request: Request): Promise<Response> {
    const env = this.env;
    const namespace = env.PROJECT_WORKSPACE;
    const workspace = namespace.get(namespace.idFromString(this.ctx.props.workspaceId));
    const agent = (name: string) => env.ConversationAgent.getByName(name);
    return handleCloudflareApiProxyRequest(request, {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      access: () => accountAccess(env),
      send: async (canonical, signal) => {
        const identity = await accountActor(env);
        if (!identity) {
          throw new Error('The workspace may no longer use the account.');
        }
        return sendCloudflareRequest(canonical, signal, (options) =>
          resolveUserWorkspaceCloudflareAccessToken(env, identity, options),
        );
      },
      command: () => workspace.runningAgentCommand(),
      propose: (command, canonical) =>
        agent(command.agentName).proposeWorkspaceCloudflareChange({
          toolCallId: command.toolCallId,
          request: canonical,
        }),
      outcome: (command, executionId) =>
        agent(command.agentName).workspaceCloudflareChangeOutcome({ toolCallId: command.toolCallId, executionId }),
      leaveInChat: (command, executionId) =>
        agent(command.agentName).leaveWorkspaceCloudflareChangeInChat({ toolCallId: command.toolCallId, executionId }),
      fileForTeamAdmins: async (canonical) => {
        const identity = runtimeConnectionIdentity(env);
        if (!identity) {
          return { kind: 'answer', status: 403, body: cloudflareApiErrorBody(NOT_CONNECTED) };
        }
        const filed = await fileTeamCloudflareChange(env, identity, { source: 'terminal' }, canonical);
        return filed.kind === 'filed' ? TEAM_FILED_ANSWER : filed.answer;
      },
      recordTerminalChange: ({ request, status, rayId }) => {
        // The workspace's log keeps each change typed in the terminal, which no one approved, for tracing later.
        console.info(
          JSON.stringify({
            event: 'cloudflare_change_from_terminal',
            userId: env.CLOUDCHEF_USER_ID,
            accountId: env.CLOUDFLARE_ACCOUNT_ID,
            method: request.method,
            path: new URL(request.url).pathname,
            status,
            rayId,
          }),
        );
      },
      sleep: (ms) => abortableSleep(ms),
    });
  }
}

/** Who the person is to the account now: its owner or a team's admin, a team's other member, or neither. */
async function accountAccess(env: CloudflareApiProxyEnv): Promise<CloudflareAccountAccess> {
  if (!runtimeConnectionIdentity(env)) {
    return { kind: 'refused', reason: NOT_CONNECTED };
  }
  if (await accountActor(env)) {
    return { kind: 'account' };
  }
  return env.CLOUDCHEF_SHARED_ACCOUNT === '1'
    ? { kind: 'team_member' }
    : { kind: 'refused', reason: 'This workspace can’t use the Cloudflare account.' };
}

/**
 * The identity requests go out as with the account's own authorization: its owner, or one of a team's admins,
 * asked afresh each time.
 */
function accountActor(env: CloudflareApiProxyEnv) {
  return readCloudflareApiRuntimeIdentity(env, async () => {
    const identity = runtimeConnectionIdentity(env);
    return identity ? (await confirmUserWorkspaceAccess(env, identity))?.organizationAdmin === true : false;
  });
}
