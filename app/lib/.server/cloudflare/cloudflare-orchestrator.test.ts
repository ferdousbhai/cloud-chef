import { describe, expect, it } from 'vitest';
import { CloudflareOrchestratorUnavailableError, createCloudflareOrchestrator } from './cloudflare-orchestrator';

describe('createCloudflareOrchestrator', () => {
  it('fails closed instead of collecting a user API token when OAuth is not configured', async () => {
    // SAFETY: only the three OAuth bindings are read, and each is absent.
    const env = {} as Env;
    await expect(createCloudflareOrchestrator(env)).rejects.toBeInstanceOf(CloudflareOrchestratorUnavailableError);
  });
});
