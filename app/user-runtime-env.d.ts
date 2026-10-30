import type { ConversationAgent } from './agents/conversation-agent';
import type { ProjectBuilderRpc, ProjectWorkspaceRpc } from './agents/builder-workspace-api';

declare global {
  /** Bindings that exist only inside the generated, user-owned runtime bundle. */
  interface Env {
    ConversationAgent: DurableObjectNamespace<ConversationAgent>;
    PROJECT_WORKSPACE: DurableObjectNamespace<ProjectWorkspaceRpc>;
    /** Each project CloudChef builds and deploys itself, one builder per project. */
    PROJECT_BUILDER: DurableObjectNamespace<ProjectBuilderRpc>;
    /** Every project's git repository, in this account's `cloudchef` namespace. */
    ARTIFACTS: Artifacts;
    /** Workers AI in this account: the builder's models, and the spoken lines of a post's clip. */
    AI: Ai;
    CLOUDCHEF_USER_RUNTIME: string;
    CLOUDCHEF_USER_ID: string;
    /** The SHA-256 of the runtime bundle this Worker runs. */
    CLOUDCHEF_RUNTIME_VERSION: string;
    CLOUDCHEF_CONTROL_PLANE_ENDPOINT: string;
    CONTROL_PLANE_SECRET: string;
    CLOUDFLARE_ACCOUNT_ID: string;
    CLOUDCHEF_CONNECTION_ID: string;
    CLOUDCHEF_CONNECTION_GENERATION: string;
    /** '1' in an organization's account, which this runtime shares with the other members' workspaces. */
    CLOUDCHEF_SHARED_ACCOUNT?: string;
  }
}

export {};
