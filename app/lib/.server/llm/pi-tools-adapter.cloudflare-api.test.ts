import { describe, expect, it, vi } from 'vitest';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { CloudflareApiModelToolContext } from './cloudflare-api-model-tools';
import { createPiToolBundle } from './pi-tools-adapter';

// SAFETY: tool adaptation is under test; no workspace-backed tool is executed in this suite.
const workspace = {} as BuilderWorkspaceApi;
const operationContext = { runWithKeepAlive: <T>(operation: () => Promise<T>) => operation() };

function context(): CloudflareApiModelToolContext {
  return {
    writeEnabled: true,
    request: vi.fn<CloudflareApiModelToolContext['request']>(async (input, options) => ({
      kind: 'cloudflare_request_proposal',
      status: 'awaiting_approval',
      executionId: 'execution-1',
      toolCallId: options.toolCallId,
      accountId: 'account-1',
      request: input,
      proposalSha256: 'a'.repeat(64),
      riskNote: 'risk',
      expiresAt: Date.now() + 60_000,
    })),
  };
}

describe('Pi Cloudflare API tool adapter', () => {
  it('adapts the tool only when admitted and preserves the Pi tool-call id in a proposal', async () => {
    expect(createPiToolBundle(workspace, operationContext).cloudflare_request).toBeUndefined();

    const tools = createPiToolBundle(workspace, operationContext, undefined, context());
    const request = tools.cloudflare_request;
    if (!request) {
      throw new Error('Expected the admitted Cloudflare request tool.');
    }
    const result = await request.execute('pi-tool-call-1', {
      method: 'DELETE',
      url: 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/old',
    });

    expect(result.details).toMatchObject({
      kind: 'cloudflare_request_proposal',
      toolCallId: 'pi-tool-call-1',
      accountId: 'account-1',
    });
  });
});
