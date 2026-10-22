import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintRuntimeCapability, verifyRuntimeCapability } from './runtime-capability';

const secret = 'runtime-capability-secret-that-is-long-enough';
const origin = 'https://cloudchef.build';

afterEach(() => {
  vi.useRealTimers();
});

describe('user runtime capabilities', () => {
  it('binds a short-lived token to its user and browser origin', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 });
    const minted = await mintRuntimeCapability({ secret, subject: 'user-1', origin });

    vi.setSystemTime(2_000);
    await expect(verifyRuntimeCapability(secret, minted.token, { origin })).resolves.toMatchObject({
      subject: 'user-1',
      origin,
      expiresAt: minted.expiresAt,
    });
    await expect(
      verifyRuntimeCapability(secret, minted.token, { origin: 'https://attacker.example' }),
    ).resolves.toBeNull();
    vi.setSystemTime(minted.expiresAt);
    await expect(verifyRuntimeCapability(secret, minted.token, { origin })).resolves.toBeNull();
  });

  it('rejects tampering and non-HTTPS origins', async () => {
    const minted = await mintRuntimeCapability({ secret, subject: 'user-1', origin });
    const tampered = `${minted.token.slice(0, -1)}${minted.token.endsWith('a') ? 'b' : 'a'}`;

    await expect(verifyRuntimeCapability(secret, tampered, { origin })).resolves.toBeNull();
    await expect(
      mintRuntimeCapability({ secret, subject: 'user-1', origin: 'http://cloudchef.example' }),
    ).rejects.toThrow('Invalid runtime capability origin');
  });
});
