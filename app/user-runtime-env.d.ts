import type { BuilderAgent } from './agents/builder-agent';
import type { ProjectWorkspaceRpc } from './agents/builder-workspace-api';

declare global {
  /** Bindings that exist only inside the generated, user-owned runtime bundle. */
  interface Env {
    BuilderAgent: DurableObjectNamespace<BuilderAgent>;
    PROJECT_WORKSPACE: DurableObjectNamespace<ProjectWorkspaceRpc>;
    CLOUDCHEF_USER_RUNTIME: string;
    CLOUDCHEF_USER_ID: string;
    CLOUDCHEF_CONTROL_PLANE_ENDPOINT: string;
    CONTROL_PLANE_SECRET: string;
    CLOUDFLARE_ACCOUNT_ID: string;
    CLOUDCHEF_CONNECTION_ID: string;
    CLOUDCHEF_CONNECTION_GENERATION: string;
    CLOUDCHEF_OAUTH_SCOPE_GRANT_STATUS: string;
  }
}

export {};
