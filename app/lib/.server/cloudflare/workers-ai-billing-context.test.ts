import { describe, expect, it } from 'vitest';
import { getUserWorkersAiCredentials } from './workers-ai-billing-context';

describe('getUserWorkersAiCredentials', () => {
  it('returns only the authenticated user-runtime binding', async () => {
    const binding = {} as Ai;

    await expect(
      getUserWorkersAiCredentials({ CLOUDCHEF_USER_RUNTIME: '1', AI: binding } as unknown as Env, 'user-1'),
    ).resolves.toEqual({ binding });
  });

  it('fails closed without the user-owned runtime binding', async () => {
    await expect(getUserWorkersAiCredentials({} as Env, 'user-1')).rejects.toThrow(
      'Workers AI must run through the user-owned Cloudflare runtime binding.',
    );
  });

  it('requires an authenticated user', async () => {
    await expect(getUserWorkersAiCredentials({} as Env, '')).rejects.toThrow('Cloudflare authentication is required.');
  });
});
