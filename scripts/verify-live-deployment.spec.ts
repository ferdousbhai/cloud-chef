import { describe, expect, it, vi } from 'vitest';
import { validateExpectedSha, verifyLocalDeployment, versionResponseErrors } from './verify-live-deployment.mjs';

const expectedSha = 'b'.repeat(40);
const versionId = '11111111-2222-3333-4444-555555555555';

async function immediateWait<T = void>(_delay?: number, value?: T): Promise<T> {
  return value as T;
}

describe('deployment version verification', () => {
  it('accepts only an exact Git commit ID', () => {
    expect(validateExpectedSha(expectedSha)).toBe(expectedSha);
    expect(() => validateExpectedSha('expected-sha')).toThrow('exact lowercase 40-hex');
    expect(() => validateExpectedSha(undefined)).toThrow('exact lowercase 40-hex');
  });

  it('requires the SHA, Worker version, and no-store response policy', () => {
    expect(
      versionResponseErrors({
        statusCode: 200,
        headers: { 'cache-control': 'no-store', 'cf-ray': 'test-FRA' },
        body: { sha: expectedSha, versionId, oauthConfigured: true },
        expectedSha,
      }),
    ).toEqual([]);

    expect(
      versionResponseErrors({
        statusCode: 200,
        headers: {},
        body: { sha: null, versionId: null, oauthConfigured: false },
        expectedSha,
      }),
    ).toEqual([
      `expected SHA ${expectedSha}, received <empty>`,
      'missing Worker version ID',
      'Cloudflare OAuth bindings are incomplete',
      'expected Cache-Control: no-store, received <empty>',
    ]);
  });

  it('requires consecutive successful direct probes', async () => {
    const responses = [
      { sha: null, versionId: null, oauthConfigured: false },
      { sha: expectedSha, versionId, oauthConfigured: true },
      { sha: expectedSha, versionId, oauthConfigured: true },
    ];
    const fetchImplementation = vi.fn(async () =>
      Response.json(responses.shift(), {
        headers: { 'Cache-Control': 'no-store', 'CF-Ray': 'test-FRA' },
      }),
    );

    await expect(
      verifyLocalDeployment({
        expectedSha,
        fetchImplementation,
        stabilizationMs: 0,
        checkIntervalMs: 0,
        consecutiveChecks: 2,
        maxAttempts: 3,
        waitImplementation: immediateWait,
        log: vi.fn(),
      }),
    ).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });
  it('probes as soon as the deploy returns and still needs five consecutive matches 5 seconds apart', async () => {
    const current = { sha: expectedSha, versionId, oauthConfigured: true };
    const previous = { sha: 'a'.repeat(40), versionId, oauthConfigured: true };
    const responses = [current, previous, current, current, current, current, current];
    const delays: number[] = [];
    const fetchImplementation = vi.fn(async () =>
      Response.json(responses.shift(), { headers: { 'Cache-Control': 'no-store' } }),
    );

    await verifyLocalDeployment({
      expectedSha,
      fetchImplementation,
      waitImplementation: async (delay?: number) => {
        delays.push(delay ?? 0);
      },
      log: vi.fn(),
    });

    // A probe that sees the previous version resets the count, so this took seven probes, not five.
    expect(fetchImplementation).toHaveBeenCalledTimes(7);
    expect(delays).toEqual([5_000, 5_000, 5_000, 5_000, 5_000, 5_000]);
  });

  it('gives a slow rollout as long to converge as the former 60-second wait did', async () => {
    const delays: number[] = [];
    const fetchImplementation = vi.fn(async () =>
      Response.json(
        { sha: 'a'.repeat(40), versionId, oauthConfigured: true },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
    );

    await expect(
      verifyLocalDeployment({
        expectedSha,
        fetchImplementation,
        waitImplementation: async (delay?: number) => {
          delays.push(delay ?? 0);
        },
        log: vi.fn(),
      }),
    ).rejects.toThrow('did not return the expected version');
    // Formerly 60 s of waiting, then 15 probes 5 s apart.
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThanOrEqual(60_000 + 14 * 5_000);
  });
});
