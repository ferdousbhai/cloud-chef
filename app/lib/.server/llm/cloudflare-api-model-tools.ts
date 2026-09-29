import type {
  CloudflareApiRequestInput,
  CloudflareRequestImmediateResult,
  CloudflareRequestProposal,
} from 'cloudchef-agent/cloudflare-api';

export type ModelToolExecutionOptions = {
  toolCallId: string;
  abortSignal?: AbortSignal;
};

/** Agent-owned callbacks keep Cloudflare API requests outside the workspace tool lane and journal. */
export type CloudflareApiModelToolContext = {
  writeEnabled: boolean;
  request: (
    input: CloudflareApiRequestInput,
    options: ModelToolExecutionOptions,
  ) => Promise<CloudflareRequestImmediateResult | CloudflareRequestProposal>;
};
