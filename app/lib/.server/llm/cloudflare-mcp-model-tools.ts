import type { z } from 'zod';
import type { CloudflareExecuteProposal, CloudflareMcpImmediateResult } from 'cloudchef-agent/cloudflare-mcp';
import type { MODEL_TOOL_INPUT_SCHEMAS } from 'cloudchef-agent/model-tool-inputs';

export type ModelToolExecutionOptions = {
  toolCallId: string;
  abortSignal?: AbortSignal;
};

export type CloudflareDocsModelInput = z.infer<typeof MODEL_TOOL_INPUT_SCHEMAS.cloudflare_docs>;
export type CloudflareSearchModelInput = z.infer<typeof MODEL_TOOL_INPUT_SCHEMAS.cloudflare_search>;
export type CloudflareExecuteModelInput = z.infer<typeof MODEL_TOOL_INPUT_SCHEMAS.cloudflare_execute>;

/** Agent-owned callbacks keep MCP operations outside the workspace tool lane and journal. */
export type CloudflareMcpModelToolContext = {
  accountId: string;
  executeEnabled: boolean;
  docs: (input: CloudflareDocsModelInput, options: ModelToolExecutionOptions) => Promise<CloudflareMcpImmediateResult>;
  search: (
    input: CloudflareSearchModelInput,
    options: ModelToolExecutionOptions,
  ) => Promise<CloudflareMcpImmediateResult>;
  proposeExecute: (
    input: CloudflareExecuteModelInput,
    options: ModelToolExecutionOptions,
  ) => Promise<CloudflareExecuteProposal>;
};
