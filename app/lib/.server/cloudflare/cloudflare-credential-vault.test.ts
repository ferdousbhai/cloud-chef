import { afterEach, describe, expect, it, vi } from 'vitest';
import { D1CloudflareCredentialVault, parseStoredOAuthCredential } from './cloudflare-credential-vault';

function createDb(
  options: {
    insertErrorAfterCommit?: Error;
    insertMismatchAfterCommit?: boolean;
    updateErrorAfterCommit?: Error;
    updateMismatchAfterCommit?: boolean;
  } = {},
) {
  type StoredCredential = {
    ciphertext_base64: string;
    iv_base64: string;
    key_version: number;
    created_at: number;
    rotated_at: number | null;
  };
  const rows = new Map<string, StoredCredential>();
  const referencedHandles = new Set<string>();
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      run: async () => {
        if (sql.startsWith('INSERT')) {
          rows.set(values[0] as string, {
            ciphertext_base64: values[1] as string,
            iv_base64: values[2] as string,
            key_version: 1,
            created_at: (values[3] as number) + (options.insertMismatchAfterCommit ? 1 : 0),
            rotated_at: null,
          });
          if (options.insertErrorAfterCommit) {
            throw options.insertErrorAfterCommit;
          }
        } else if (sql.includes('UPDATE cloudflare_credentials')) {
          const existing = rows.get(values[3] as string);
          if (!existing || existing.ciphertext_base64 !== values[4] || existing.iv_base64 !== values[5]) {
            return { success: true, meta: { changes: 0 } };
          }
          rows.set(values[3] as string, {
            ciphertext_base64: values[0] as string,
            iv_base64: values[1] as string,
            key_version: existing.key_version,
            created_at: existing.created_at,
            rotated_at: (values[2] as number) + (options.updateMismatchAfterCommit ? 1 : 0),
          });
          if (options.updateErrorAfterCommit) {
            throw options.updateErrorAfterCommit;
          }
        } else if (sql.startsWith('DELETE FROM cloudflare_credentials')) {
          const handle = values[0] as string;
          const changes = !referencedHandles.has(handle) && rows.delete(handle) ? 1 : 0;
          return { success: true, meta: { changes } };
        }
        return { success: true, meta: { changes: 1 } };
      },
      first: async () => {
        if (sql.includes('SELECT 1 AS found')) {
          const row = rows.get(values[0] as string);
          if (!row) {
            return null;
          }
          const matches =
            row.ciphertext_base64 === values[1] &&
            row.iv_base64 === values[2] &&
            row.key_version === 1 &&
            row.rotated_at === values[3] &&
            (values.length === 4 || row.created_at === values[4]);
          return matches ? { found: 1 } : null;
        }
        return rows.get(values[0] as string) ?? null;
      },
    }),
  }));
  return { db: { prepare } as unknown as D1Database, prepare, referencedHandles, rows };
}

const OAUTH = { clientId: 'client-1', clientSecret: 'client-secret' };

/** An OAuth grant whose access token is good for an hour. */
function grant(accessToken: string) {
  return { accessToken, refreshToken: 'refresh-token', expiresAt: Date.now() + 3_600_000 };
}

function encryptionKey(): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('D1CloudflareCredentialVault', () => {
  it('stores only authenticated ciphertext and resolves it by opaque handle', async () => {
    const { db, rows } = createDb();
    const vault = new D1CloudflareCredentialVault(db, encryptionKey(), OAUTH);
    const handle = await vault.storeOAuthCredential(grant('cloudflare-secret-token'));

    expect(handle).not.toContain('cloudflare-secret-token');
    expect(JSON.stringify(rows.get(handle))).not.toContain('cloudflare-secret-token');
    await expect(vault.resolve(handle)).resolves.toBe('cloudflare-secret-token');
  });

  it('rejects a key that is not 256 bits', async () => {
    const { db } = createDb();
    const vault = new D1CloudflareCredentialVault(db, btoa('too-short'), OAUTH);
    await expect(vault.storeOAuthCredential(grant('token'))).rejects.toThrow('exactly 32 bytes');
  });

  it('rejects partial OAuth refresh configuration', () => {
    expect(() =>
      D1CloudflareCredentialVault.fromEnv({
        DB: createDb().db,
        CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: encryptionKey(),
        CLOUDFLARE_OAUTH_CLIENT_ID: 'client-1',
      } as unknown as Env),
    ).toThrow('OAuth refresh configuration is incomplete');
  });

  it('rejects a stored value that is not an OAuth credential', () => {
    expect(() => parseStoredOAuthCredential('plain-api-token')).toThrow(
      'Stored Cloudflare OAuth credential is invalid',
    );
    expect(() => parseStoredOAuthCredential('{invalid')).toThrow('Stored Cloudflare OAuth credential is invalid');
    expect(() => parseStoredOAuthCredential(JSON.stringify({ version: 1, accessToken: 'token' }))).toThrow(
      'Stored Cloudflare OAuth credential is invalid',
    );
  });

  it('adopts only the exact credential insert that committed before acknowledgement failed', async () => {
    const acknowledgementError = new Error('credential insert acknowledgement failed');
    const exact = createDb({ insertErrorAfterCommit: acknowledgementError });
    const mismatched = createDb({
      insertErrorAfterCommit: acknowledgementError,
      insertMismatchAfterCommit: true,
    });

    await expect(
      new D1CloudflareCredentialVault(exact.db, encryptionKey(), OAUTH).storeOAuthCredential(grant('token')),
    ).resolves.toEqual(expect.any(String));
    await expect(
      new D1CloudflareCredentialVault(mismatched.db, encryptionKey(), OAUTH).storeOAuthCredential(grant('token')),
    ).rejects.toBe(acknowledgementError);
  });

  it('refreshes expired OAuth credentials and rotates the encrypted record', async () => {
    const { db, rows } = createDb();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
      );
    vi.stubGlobal('fetch', request);
    const vault = new D1CloudflareCredentialVault(db, encryptionKey(), OAUTH);
    const handle = await vault.storeOAuthCredential({
      accessToken: 'expired-access',
      refreshToken: 'old-refresh',
      expiresAt: 1,
    });
    const before = JSON.stringify(rows.get(handle));

    await expect(vault.resolve(handle)).resolves.toBe('fresh-access');
    expect(request).toHaveBeenCalledWith(
      'https://dash.cloudflare.com/oauth2/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: `Basic ${btoa('client-1:client-secret')}` }),
      }),
    );
    expect(JSON.stringify(rows.get(handle))).not.toBe(before);
    expect(JSON.stringify(rows.get(handle))).not.toContain('fresh-access');
  });

  it('forces refresh of a still-valid OAuth access token at an authenticated phase boundary', async () => {
    const { db } = createDb();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ access_token: 'forced-fresh-access', expires_in: 3600 }));
    vi.stubGlobal('fetch', request);
    const vault = new D1CloudflareCredentialVault(db, encryptionKey(), OAUTH);
    const handle = await vault.storeOAuthCredential({
      accessToken: 'still-valid-access',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
    });

    await expect(vault.resolve(handle, { forceRefresh: true })).resolves.toBe('forced-fresh-access');
    expect(request).toHaveBeenCalledOnce();
  });

  it('answers a forced refresh asked again within a minute with the token it just rotated to', async () => {
    const { db, rows } = createDb();
    let issued = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      issued += 1;
      return Response.json({ access_token: `forced-${issued}`, expires_in: 3600 });
    });
    vi.stubGlobal('fetch', request);
    const vault = new D1CloudflareCredentialVault(db, encryptionKey(), OAUTH);
    const handle = await vault.storeOAuthCredential({
      accessToken: 'still-valid-access',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
    });

    await expect(vault.resolve(handle, { forceRefresh: true })).resolves.toBe('forced-1');
    await expect(vault.resolve(handle, { forceRefresh: true })).resolves.toBe('forced-1');
    expect(request).toHaveBeenCalledOnce();

    // A minute on, a forced refresh reaches Cloudflare again.
    const stored = rows.get(handle);
    if (!stored) {
      throw new Error('The credential was not stored.');
    }
    rows.set(handle, { ...stored, rotated_at: Date.now() - 61_000 });
    await expect(vault.resolve(handle, { forceRefresh: true })).resolves.toBe('forced-2');
  });

  it('adopts only the exact OAuth refresh rotation that committed before acknowledgement failed', async () => {
    const acknowledgementError = new Error('credential rotation acknowledgement failed');
    const exact = createDb({ updateErrorAfterCommit: acknowledgementError });
    const mismatched = createDb({
      updateErrorAfterCommit: acknowledgementError,
      updateMismatchAfterCommit: true,
    });
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ access_token: 'fresh-access', refresh_token: 'fresh-refresh' }));
    vi.stubGlobal('fetch', request);
    const exactVault = new D1CloudflareCredentialVault(exact.db, encryptionKey(), OAUTH);
    const mismatchedVault = new D1CloudflareCredentialVault(mismatched.db, encryptionKey(), OAUTH);
    const exactHandle = await exactVault.storeOAuthCredential({
      accessToken: 'expired-access',
      refreshToken: 'old-refresh',
      expiresAt: 1,
    });
    const mismatchedHandle = await mismatchedVault.storeOAuthCredential({
      accessToken: 'expired-access',
      refreshToken: 'old-refresh',
      expiresAt: 1,
    });

    await expect(exactVault.resolve(exactHandle)).resolves.toBe('fresh-access');
    await expect(mismatchedVault.resolve(mismatchedHandle)).rejects.toBe(acknowledgementError);
  });

  it('adopts a valid credential concurrently rotated before a single-use refresh token is rejected', async () => {
    const { db } = createDb();
    const key = encryptionKey();
    const winnerVault = new D1CloudflareCredentialVault(db, key, OAUTH);
    const loserVault = new D1CloudflareCredentialVault(db, key, OAUTH);
    let handle = '';
    // The loser's refresh reaches Cloudflare first; the winner's refresh, while it waits, rotates the grant.
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        await winnerVault.resolve(handle);
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      })
      .mockImplementationOnce(async () =>
        Response.json({ access_token: 'winner-access', refresh_token: 'winner-refresh', expires_in: 3600 }),
      );
    vi.stubGlobal('fetch', request);
    handle = await loserVault.storeOAuthCredential({
      accessToken: 'expired-access',
      refreshToken: 'single-use-refresh',
      expiresAt: 1,
    });

    await expect(loserVault.resolve(handle)).resolves.toBe('winner-access');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['unchanged', 'invalid'] as const)(
    'keeps a provider refresh failure fatal when the stored credential is %s',
    async (mode) => {
      const { db, rows } = createDb();
      const key = encryptionKey();
      let handle = '';
      const request = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (mode === 'invalid') {
          const current = rows.get(handle);
          if (current) {
            rows.set(handle, { ...current, ciphertext_base64: 'invalid-base64' });
          }
        }
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      });
      vi.stubGlobal('fetch', request);
      const vault = new D1CloudflareCredentialVault(db, key, OAUTH, 0);
      handle = await vault.storeOAuthCredential({
        accessToken: 'expired-access',
        refreshToken: 'single-use-refresh',
        expiresAt: 1,
      });

      await expect(vault.resolve(handle)).rejects.toThrow('authorization expired');
    },
  );

  it('waits for a refresh made at the same moment to land before deciding a refused grant ended', async () => {
    const { db } = createDb();
    const key = encryptionKey();
    const winnerVault = new D1CloudflareCredentialVault(db, key, OAUTH);
    const loserVault = new D1CloudflareCredentialVault(db, key, OAUTH, 50);
    let handle = '';
    // Cloudflare refuses the loser's refresh token, rotated by the winner's refresh, which lands only afterwards.
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        setTimeout(() => void winnerVault.resolve(handle), 0);
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      })
      .mockImplementationOnce(async () =>
        Response.json({ access_token: 'winner-access', refresh_token: 'winner-refresh', expires_in: 3600 }),
      );
    vi.stubGlobal('fetch', request);
    handle = await loserVault.storeOAuthCredential({
      accessToken: 'expired-access',
      refreshToken: 'single-use-refresh',
      expiresAt: 1,
    });

    await expect(loserVault.stillAuthorizes(handle)).resolves.toBe(true);
    await expect(loserVault.resolve(handle)).resolves.toBe('winner-access');
  });

  describe('stillAuthorizes', () => {
    it('shows Cloudflare a current access token as it is, never rotating the grant the workspaces use', async () => {
      const { db, rows } = createDb();
      const request = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
      vi.stubGlobal('fetch', request);
      const vault = new D1CloudflareCredentialVault(db, encryptionKey(), OAUTH, 0);
      const handle = await vault.storeOAuthCredential(grant('current-access'));
      const stored = { ...rows.get(handle) };

      await expect(vault.stillAuthorizes(handle)).resolves.toBe(true);

      expect(request).toHaveBeenCalledTimes(1);
      const [url, init] = request.mock.calls[0];
      expect(url).toBe('https://api.cloudflare.com/client/v4/user');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer current-access');
      expect(rows.get(handle)).toEqual(stored);
    });

    it('says a grant ended once Cloudflare refuses its current access token and nothing rotated it', async () => {
      const { db } = createDb();
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async () => Response.json({ success: false }, { status: 401 })),
      );
      const vault = new D1CloudflareCredentialVault(db, encryptionKey(), OAUTH, 0);
      const handle = await vault.storeOAuthCredential(grant('revoked-access'));

      await expect(vault.stillAuthorizes(handle)).resolves.toBe(false);
    });

    it('counts a refused access token as working when a refresh elsewhere rotates it meanwhile', async () => {
      const { db, rows } = createDb();
      let handle = '';
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async () => {
          // A workspace's refresh lands just after Cloudflare refused the token it replaced.
          setTimeout(() => {
            const current = rows.get(handle);
            if (current) {
              rows.set(handle, { ...current, ciphertext_base64: `${current.ciphertext_base64}x`, rotated_at: 2 });
            }
          }, 0);
          return Response.json({ success: false }, { status: 401 });
        }),
      );
      const vault = new D1CloudflareCredentialVault(db, encryptionKey(), OAUTH, 50);
      handle = await vault.storeOAuthCredential(grant('rotated-access'));

      await expect(vault.stillAuthorizes(handle)).resolves.toBe(true);
    });

    it.each([
      ['Cloudflare failing', async () => new Response('unavailable', { status: 503 })],
      [
        'Cloudflare unreachable',
        async () => {
          throw new TypeError('network');
        },
      ],
    ] as const)('counts %s as working', async (_case, answer) => {
      const { db } = createDb();
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(answer));
      const vault = new D1CloudflareCredentialVault(db, encryptionKey(), OAUTH, 0);
      const handle = await vault.storeOAuthCredential(grant('current-access'));

      await expect(vault.stillAuthorizes(handle)).resolves.toBe(true);
    });

    it('refreshes only an expired access token, as the next workspace call would, and is false once refused', async () => {
      const { db } = createDb();
      const request = vi.fn<typeof fetch>(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
      vi.stubGlobal('fetch', request);
      const vault = new D1CloudflareCredentialVault(db, encryptionKey(), OAUTH, 0);
      const handle = await vault.storeOAuthCredential({ accessToken: 'old', refreshToken: 'ended', expiresAt: 1 });

      await expect(vault.stillAuthorizes(handle)).resolves.toBe(false);
      expect(request.mock.calls[0][0]).toBe('https://dash.cloudflare.com/oauth2/token');
    });

    it('is false for a credential that is gone', async () => {
      const { db } = createDb();
      const vault = new D1CloudflareCredentialVault(db, encryptionKey(), OAUTH, 0);
      await expect(vault.stillAuthorizes('missing')).resolves.toBe(false);
    });
  });

  it('deletes only an unreferenced credential in the same D1 statement', async () => {
    const { db, prepare, referencedHandles, rows } = createDb();
    const vault = new D1CloudflareCredentialVault(db, encryptionKey(), OAUTH);
    const liveHandle = await vault.storeOAuthCredential(grant('live-token'));
    const orphanHandle = await vault.storeOAuthCredential(grant('orphan-token'));
    referencedHandles.add(liveHandle);

    await expect(vault.deleteIfUnreferenced(liveHandle)).resolves.toBe(false);
    await expect(vault.deleteIfUnreferenced(orphanHandle)).resolves.toBe(true);

    expect(rows.has(liveHandle)).toBe(true);
    expect(rows.has(orphanHandle)).toBe(false);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('NOT EXISTS'));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('credential_handle = ?'));
  });
});
