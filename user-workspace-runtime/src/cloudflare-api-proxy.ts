import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ConversationAgent } from '../../app/agents/conversation-agent';
import {
  readCloudflareApiRuntimeIdentity,
  runtimeConnectionIdentity,
} from '../../app/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import {
  handleCloudflareApiProxyRequest,
  sendCloudflareRead,
} from '../../app/lib/.server/cloudflare/cloudflare-api-proxy';
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

/** In a team's account only its admins read it directly: its authorization reaches every member's work. */
const TEAM_READ_REFUSAL =
  'In a team’s account only its admins read the account directly. Make the change itself: it goes to the ' +
  'team’s admins to approve.';

/**
 * Minted for one workspace by its ProjectWorkspace, as the handler for cloudflare-api.internal in its container:
 * reads go to Cloudflare with the account's authorization, changes to the agent whose command asked, which keeps
 * them until the person approves.
 */
export class CloudflareApiProxy extends WorkerEntrypoint<CloudflareApiProxyEnv, { workspaceId: string }> {
  override fetch(request: Request): Promise<Response> {
    const env = this.env;
    const namespace = env.PROJECT_WORKSPACE;
    const workspace = namespace.get(namespace.idFromString(this.ctx.props.workspaceId));
    const agent = (name: string) => env.ConversationAgent.getByName(name);
    return handleCloudflareApiProxyRequest(request, {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      readRefusal: async () => {
        if (!runtimeConnectionIdentity(env)) {
          return 'This workspace is not connected to CloudChef.';
        }
        return (await readReader(env)) ? null : TEAM_READ_REFUSAL;
      },
      read: async (canonical, signal) => {
        const identity = await readReader(env);
        if (!identity) {
          throw new Error('The workspace may no longer read the account.');
        }
        return sendCloudflareRead(canonical, signal, (options) =>
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
      withdraw: (command, executionId) =>
        agent(command.agentName).withdrawWorkspaceCloudflareChange({ toolCallId: command.toolCallId, executionId }),
      sleep: (ms) => abortableSleep(ms),
    });
  }
}

/** The identity reads go out as: the account's owner, or one of a team's admins, asked afresh each time. */
function readReader(env: CloudflareApiProxyEnv) {
  return readCloudflareApiRuntimeIdentity(env, async () => {
    const identity = runtimeConnectionIdentity(env);
    return identity ? (await confirmUserWorkspaceAccess(env, identity))?.organizationAdmin === true : false;
  });
}
