import { describe, expect, it, vi } from 'vitest';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { CloudflareApiModelToolContext } from './cloudflare-api-model-tools';
import { createWorkersAiTools } from './workers-ai-tools';

// SAFETY: tool construction is under test; no workspace-backed tool is executed in this suite.
const workspace = {} as BuilderWorkspaceApi;
const operationContext = { runWithKeepAlive: <T>(operation: () => Promise<T>) => operation() };

function apiContext(writeEnabled = true): CloudflareApiModelToolContext {
  return {
    writeEnabled,
    request: vi.fn<CloudflareApiModelToolContext['request']>(async () => ({
      kind: 'cloudflare_request_result',
      status: 'success',
      accountId: 'account-1',
      content: '{"success":true}',
      requestId: 'ray-1',
      httpStatus: 200,
      truncated: false,
    })),
  };
}

describe('canonical Cloudflare API tool', () => {
  it('forwards a dry-run request without the workspace lane', async () => {
    const cloudflareApi = apiContext();
    const tools = createWorkersAiTools(workspace, operationContext, undefined, cloudflareApi);
    const request = { method: 'GET', url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts' };

    await expect(tools.cloudflare_request?.execute?.(request, { toolCallId: 'request-1' })).resolves.toMatchObject({
      status: 'success',
    });
    expect(cloudflareApi.request).toHaveBeenCalledWith(request, { toolCallId: 'request-1' });
  });

  it('rejects unknown fields and methods before the agent is reached', async () => {
    const cloudflareApi = apiContext();
    const tools = createWorkersAiTools(workspace, operationContext, undefined, cloudflareApi);

    await expect(
      tools.cloudflare_request?.execute?.(
        { method: 'GET', url: 'https://api.cloudflare.com/client/v4/zones', account_id: 'other' },
        { toolCallId: 'request-1' },
      ),
    ).rejects.toThrow();
    await expect(
      tools.cloudflare_request?.execute?.(
        { method: 'OPTIONS', url: 'https://api.cloudflare.com/client/v4/zones' },
        { toolCallId: 'request-2' },
      ),
    ).rejects.toThrow();
    expect(cloudflareApi.request).not.toHaveBeenCalled();
  });

  it('does not offer the tool when admission is absent', () => {
    expect(createWorkersAiTools(workspace, operationContext).cloudflare_request).toBeUndefined();
  });
});
