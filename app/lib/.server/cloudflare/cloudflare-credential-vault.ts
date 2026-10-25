import { z } from 'zod';
import { base64ToBytes, bytesToBase64 } from '~/lib/hex-digest';
import { CREDENTIAL_UNREFERENCED } from './cloudflare-connection-repository';
const AES_GCM_IV_BYTES = 12;
const AES_256_KEY_BYTES = 32;
/** Bounds both client-authenticated OAuth calls: the refresh and the revocation. */
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const OAUTH_REVOKE_URL = 'https://dash.cloudflare.com/oauth2/revoke';
/** Answers any working OAuth access token: how a current one is checked without refreshing it. */
const CLOUDFLARE_USER_URL = 'https://api.cloudflare.com/client/v4/user';
/**
 * How long a refused refresh waits for a concurrent one to land before deciding the grant ended. Cloudflare
 * rotates refresh tokens, so of two refreshes made with one token at once, the later is refused.
 */
const CONCURRENT_REFRESH_SETTLE_MS = 2_000;
/**
 * A forced refresh of a credential rotated more recently than this returns the token it was rotated
 * to: the token is minutes old, and a caller asking again and again must not refresh with Cloudflare
 * on every call.
 */
const FORCED_REFRESH_INTERVAL_MS = 60_000;

/** The credential no longer authorizes anything: it is gone, or Cloudflare refuses to refresh its grant. */
class CloudflareAuthorizationEndedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareAuthorizationEndedError';
  }
}

type CredentialRow = {
  ciphertext_base64: string;
  iv_base64: string;
  created_at: number;
  rotated_at: number | null;
};

export class D1CloudflareCredentialVault {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKeyBase64: string,
    private readonly oauth: { clientId: string; clientSecret: string },
    private readonly concurrentRefreshSettleMs = CONCURRENT_REFRESH_SETTLE_MS,
  ) {}

  static fromEnv(env: Env): D1CloudflareCredentialVault {
    if (!env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
      throw new Error('Cloudflare credential encryption is not configured.');
    }
    const clientId = env.CLOUDFLARE_OAUTH_CLIENT_ID;
    const clientSecret = env.CLOUDFLARE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('Cloudflare OAuth refresh configuration is incomplete.');
    }
    return new D1CloudflareCredentialVault(env.DB, env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY, {
      clientId,
      clientSecret,
    });
  }

  /** Stores an OAuth grant, the only kind of credential a connection holds, and returns its handle. */
  async storeOAuthCredential(credential: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }): Promise<string> {
    const now = Date.now();
    const encrypted = await this.encrypt(JSON.stringify({ version: 1, ...credential }));
    const handle = crypto.randomUUID();
    try {
      await this.db
        .prepare(
          `INSERT INTO cloudflare_credentials
            (handle, ciphertext_base64, iv_base64, key_version, created_at)
           VALUES (?, ?, ?, 1, ?)`,
        )
        .bind(handle, encrypted.ciphertextBase64, encrypted.ivBase64, now)
        .run();
    } catch (error) {
      const committed = await this.isExactCredentialStored({
        handle,
        ...encrypted,
        createdAt: now,
        rotatedAt: null,
      }).catch((readError) => {
        console.warn('Unable to verify Cloudflare credential commit', readError);
        return false;
      });
      if (!committed) {
        throw error;
      }
    }
    return handle;
  }

  async resolve(credentialHandle: string, options: { forceRefresh?: boolean } = {}): Promise<string> {
    const row = await this.readCredentialRow(credentialHandle);
    if (!row) {
      throw new CloudflareAuthorizationEndedError('Cloudflare credential is unavailable.');
    }
    const oauthCredential = parseStoredOAuthCredential(await this.decryptCredentialRow(row));
    const now = Date.now();
    const recentlyRotated = (row.rotated_at ?? 0) > now - FORCED_REFRESH_INTERVAL_MS;
    if ((!options.forceRefresh || recentlyRotated) && oauthCredential.expiresAt > now + 60_000) {
      return oauthCredential.accessToken;
    }
    return this.refreshOAuthCredential(credentialHandle, oauthCredential, row);
  }

  /**
   * Whether the credential still works: false once it is gone or Cloudflare refuses its grant (revoked, or
   * its refresh expired). It never refreshes a token that is still good, which would rotate the grant under
   * the workspaces using it: a current access token is shown to Cloudflare as it is, and only an expired one
   * is refreshed, as the next workspace call would. Anything that says nothing about the grant (Cloudflare
   * unreachable or failing, or another refresh rotating the token meanwhile) counts as working.
   */
  async stillAuthorizes(credentialHandle: string): Promise<boolean> {
    const row = await this.readCredentialRow(credentialHandle);
    if (!row) {
      return false;
    }
    const credential = parseStoredOAuthCredential(await this.decryptCredentialRow(row));
    if (credential.expiresAt <= Date.now() + 60_000) {
      try {
        await this.refreshOAuthCredential(credentialHandle, credential, row);
        return true;
      } catch (error) {
        return !(error instanceof CloudflareAuthorizationEndedError);
      }
    }
    let response: Response;
    try {
      response = await fetch(CLOUDFLARE_USER_URL, {
        headers: { authorization: `Bearer ${credential.accessToken}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
      });
    } catch {
      return true;
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 401) {
      return true;
    }
    // Refused: ended, unless a refresh elsewhere rotated the token just now.
    return (await this.rotatedSince(credentialHandle, row)) || this.rotatedAfterSettling(credentialHandle, row);
  }

  /**
   * Ask Cloudflare to revoke the stored grant so erasing the ciphertext also ends
   * CloudChef's access. Returns false when there is nothing to revoke or the
   * provider declined; callers treat that as an outcome to report, not a failure.
   */
  async revokeOAuthCredential(credentialHandle: string): Promise<boolean> {
    const row = await this.readCredentialRow(credentialHandle);
    if (!row) {
      return false;
    }
    const credential = parseStoredOAuthCredential(await this.decryptCredentialRow(row));
    const response = await fetch(OAUTH_REVOKE_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${this.oauth.clientId}:${this.oauth.clientSecret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.oauth.clientId,
        token_type_hint: 'refresh_token',
        token: credential.refreshToken,
      }),
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  }

  async deleteIfUnreferenced(credentialHandle: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM cloudflare_credentials
         WHERE handle = ?1
           AND ${CREDENTIAL_UNREFERENCED}`,
      )
      .bind(credentialHandle)
      .run();
    return result.meta.changes === 1;
  }

  private async refreshOAuthCredential(
    credentialHandle: string,
    credential: OAuthCredential,
    stored: CredentialRow,
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`${this.oauth.clientId}:${this.oauth.clientSecret}`)}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.oauth.clientId,
          refresh_token: credential.refreshToken,
        }),
        signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const concurrent = await this.readConcurrentRefreshSafely(credentialHandle, stored);
      if (concurrent) {
        return concurrent;
      }
      throw error;
    }
    const token = refreshedTokenSchema.safeParse(await response.json().catch(() => null)).data;
    if (!response.ok || !token?.access_token) {
      const concurrent = await this.readConcurrentRefreshSafely(credentialHandle, stored);
      if (concurrent) {
        return concurrent;
      }
      // Cloudflare answers a revoked or expired grant with 400 (invalid_grant), and also a refresh token another
      // refresh has just rotated: that one is given time to land first. Anything else, such as an outage, says
      // nothing about the grant.
      const refused = response.status === 400 || response.status === 401;
      if (refused) {
        await sleep(this.concurrentRefreshSettleMs);
        const settled = await this.readConcurrentRefreshSafely(credentialHandle, stored);
        if (settled) {
          return settled;
        }
      }
      throw refused
        ? new CloudflareAuthorizationEndedError('Cloudflare authorization expired. Connect Cloudflare again.')
        : new Error("Cloudflare couldn't be reached just now. Try again.");
    }
    const refreshed: OAuthCredential = {
      version: 1,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? credential.refreshToken,
      expiresAt: Date.now() + Math.max(0, token.expires_in ?? 3600) * 1_000,
    };
    const encrypted = await this.encrypt(JSON.stringify(refreshed));
    const rotatedAt = Date.now();
    const expectedRotation = {
      handle: credentialHandle,
      ...encrypted,
      createdAt: stored.created_at,
      rotatedAt,
    };
    try {
      const result = await this.db
        .prepare(
          `UPDATE cloudflare_credentials
           SET ciphertext_base64 = ?, iv_base64 = ?, rotated_at = ?
           WHERE handle = ? AND ciphertext_base64 = ? AND iv_base64 = ?`,
        )
        .bind(
          encrypted.ciphertextBase64,
          encrypted.ivBase64,
          rotatedAt,
          credentialHandle,
          stored.ciphertext_base64,
          stored.iv_base64,
        )
        .run();
      if (result.meta.changes === 1) {
        return refreshed.accessToken;
      }
    } catch (error) {
      const committed = await this.isExactCredentialStored(expectedRotation).catch((readError) => {
        console.warn('Unable to verify credential rotation commit', readError);
        return false;
      });
      if (committed) {
        return refreshed.accessToken;
      }
      const concurrent = await this.readConcurrentRefreshSafely(credentialHandle, stored, encrypted);
      if (concurrent) {
        return concurrent;
      }
      throw error;
    }
    if (await this.isExactCredentialStored(expectedRotation)) {
      return refreshed.accessToken;
    }
    const concurrent = await this.readConcurrentRefreshSafely(credentialHandle, stored, encrypted);
    if (concurrent) {
      return concurrent;
    }
    throw new Error('Cloudflare credential changed while its OAuth token was being refreshed.');
  }

  /** Whether the stored credential changed since `previous` was read: another refresh rotated it. */
  private async rotatedSince(credentialHandle: string, previous: CredentialRow): Promise<boolean> {
    const current = await this.readCredentialRow(credentialHandle).catch(() => null);
    return (
      current !== null &&
      current.created_at === previous.created_at &&
      (current.ciphertext_base64 !== previous.ciphertext_base64 || current.iv_base64 !== previous.iv_base64)
    );
  }

  private async rotatedAfterSettling(credentialHandle: string, previous: CredentialRow): Promise<boolean> {
    await sleep(this.concurrentRefreshSettleMs);
    return this.rotatedSince(credentialHandle, previous);
  }

  private readConcurrentRefreshSafely(
    credentialHandle: string,
    previous: CredentialRow,
    rejected?: { ciphertextBase64: string; ivBase64: string },
  ): Promise<string | null> {
    return this.readConcurrentRefresh(credentialHandle, previous, rejected).catch((error) => {
      console.warn('Unable to read concurrent credential refresh', error);
      return null;
    });
  }

  private async readConcurrentRefresh(
    credentialHandle: string,
    previous: CredentialRow,
    rejected?: { ciphertextBase64: string; ivBase64: string },
  ): Promise<string | null> {
    const current = await this.readCredentialRow(credentialHandle);
    if (
      !current ||
      current.created_at !== previous.created_at ||
      (current.ciphertext_base64 === previous.ciphertext_base64 && current.iv_base64 === previous.iv_base64) ||
      (rejected && current.ciphertext_base64 === rejected.ciphertextBase64 && current.iv_base64 === rejected.ivBase64)
    ) {
      return null;
    }
    const credential = parseStoredOAuthCredential(await this.decryptCredentialRow(current));
    return credential.expiresAt > Date.now() + 60_000 ? credential.accessToken : null;
  }

  private async readCredentialRow(credentialHandle: string): Promise<CredentialRow | null> {
    return this.db
      .prepare(
        `SELECT ciphertext_base64, iv_base64, created_at, rotated_at FROM cloudflare_credentials WHERE handle = ?`,
      )
      .bind(credentialHandle)
      .first<CredentialRow>();
  }

  private async decryptCredentialRow(row: CredentialRow): Promise<string> {
    const key = await importEncryptionKey(this.encryptionKeyBase64, ['decrypt']);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(row.iv_base64) },
        key,
        base64ToBytes(row.ciphertext_base64),
      );
    } catch {
      throw new Error('Cloudflare credential could not be decrypted.');
    }
    return new TextDecoder().decode(plaintext);
  }

  private async isExactCredentialStored(expected: {
    handle: string;
    ciphertextBase64: string;
    ivBase64: string;
    createdAt: number;
    rotatedAt: number | null;
  }): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS found FROM cloudflare_credentials
         WHERE handle = ? AND ciphertext_base64 = ? AND iv_base64 = ? AND key_version = 1
           AND rotated_at IS ? AND created_at = ?`,
      )
      .bind(expected.handle, expected.ciphertextBase64, expected.ivBase64, expected.rotatedAt, expected.createdAt)
      .first<{ found: number }>();
    return row?.found === 1;
  }

  private async encrypt(value: string): Promise<{ ciphertextBase64: string; ivBase64: string }> {
    const key = await importEncryptionKey(this.encryptionKeyBase64, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
    return { ciphertextBase64: bytesToBase64(new Uint8Array(ciphertext)), ivBase64: bytesToBase64(iv) };
  }
}

type OAuthCredential = {
  version: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

const storedOAuthCredentialSchema = z.object({
  version: z.literal(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
}) satisfies z.ZodType<OAuthCredential>;

/** Cloudflare's refresh response: decoded leniently so the explicit checks below own every message. */
const refreshedTokenSchema = z.looseObject({
  access_token: z.string().optional().catch(undefined),
  refresh_token: z.string().optional().catch(undefined),
  expires_in: z.number().optional().catch(undefined),
});

export function parseStoredOAuthCredential(value: string): OAuthCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Stored Cloudflare OAuth credential is invalid.', { cause: error });
  }
  const credential = storedOAuthCredentialSchema.safeParse(parsed);
  if (!credential.success) {
    throw new Error('Stored Cloudflare OAuth credential is invalid.');
  }
  return credential.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importEncryptionKey(value: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const bytes = base64ToBytes(value);
  if (bytes.byteLength !== AES_256_KEY_BYTES) {
    throw new Error('CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY must contain exactly 32 bytes.');
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usages);
}
