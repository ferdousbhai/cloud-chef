import { ORGANIZATION_QUOTA_WINDOW_MS } from './organizations.server';

const CLOUDFLARE_AUTH_RETENTION_SWEEP_LIMIT = 100;
/**
 * How many batches one sweep may run: it goes on while any table still had a full batch to delete, so
 * states created faster than one batch per sweep (every 15 minutes) are still cleared, up to 2,500 rows
 * a table per sweep.
 */
const CLOUDFLARE_AUTH_RETENTION_SWEEP_ROUNDS = 25;
export const UNREFERENCED_CREDENTIAL_RETENTION_MS = 24 * 60 * 60 * 1000;
/** The window of the per-address limit on sign-in emails (`EMAIL_SIGN_IN_LINKS_PER_HOUR`). */
const EMAIL_SIGN_IN_TOKEN_RETENTION_MS = 60 * 60 * 1000;

export async function pruneCloudflareAuthData(db: D1Database): Promise<void> {
  const now = Date.now();
  const limit = CLOUDFLARE_AUTH_RETENTION_SWEEP_LIMIT;
  for (let round = 0; round < CLOUDFLARE_AUTH_RETENTION_SWEEP_ROUNDS; round += 1) {
    const results = await pruneBatch(db, now, limit);
    if (!results.some((result) => result.meta.changes >= limit)) {
      return;
    }
  }
}

function pruneBatch(db: D1Database, now: number, limit: number): Promise<D1Result[]> {
  const credentialCreatedBefore = now - UNREFERENCED_CREDENTIAL_RETENTION_MS;
  return db.batch([
    db
      .prepare(
        `DELETE FROM cloudflare_oauth_states
         WHERE id IN (
           SELECT id FROM cloudflare_oauth_states
           WHERE status IN ('pending', 'completed', 'expired', 'error')
             AND expires_at <= ?
           ORDER BY expires_at, id
           LIMIT ?
         )`,
      )
      .bind(now, limit),
    db
      .prepare(
        `DELETE FROM cloudflare_auth_sessions
         WHERE id IN (
           SELECT id FROM cloudflare_auth_sessions
           WHERE expires_at <= ?
           ORDER BY expires_at, id
           LIMIT ?
         )`,
      )
      .bind(now, limit),
    db
      .prepare(
        // Kept an hour after they're sent, used or not: they count toward each address's hourly limit.
        `DELETE FROM email_sign_in_tokens
         WHERE token_hash IN (
           SELECT token_hash FROM email_sign_in_tokens WHERE created_at <= ? ORDER BY created_at LIMIT ?
         )`,
      )
      .bind(now - EMAIL_SIGN_IN_TOKEN_RETENTION_MS, limit),
    db
      .prepare(
        `DELETE FROM google_sign_in_states
         WHERE id IN (SELECT id FROM google_sign_in_states WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
      )
      .bind(now, limit),
    db
      .prepare(
        `DELETE FROM github_install_states
         WHERE id IN (SELECT id FROM github_install_states WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
      )
      .bind(now, limit),
    db
      .prepare(
        // Accepted or not, an invite is read only until it expires; the limits count organization_quota_events.
        `DELETE FROM organization_invites
         WHERE id IN (SELECT id FROM organization_invites WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
      )
      .bind(now, limit),
    db
      .prepare(
        // Kept as long as the longest limit they count toward.
        `DELETE FROM organization_quota_events
         WHERE rowid IN (
           SELECT rowid FROM organization_quota_events WHERE created_at <= ? ORDER BY created_at LIMIT ?
         )`,
      )
      .bind(now - ORGANIZATION_QUOTA_WINDOW_MS, limit),
    db
      .prepare(
        `DELETE FROM cloudflare_credentials
         WHERE handle IN (
           SELECT credential.handle
           FROM cloudflare_credentials AS credential
           WHERE credential.created_at <= ?
             AND (credential.rotated_at IS NULL OR credential.rotated_at <= ?)
             AND NOT EXISTS (
               SELECT 1 FROM cloudflare_authorizations AS authorization
               WHERE authorization.credential_handle = credential.handle
             )
             AND NOT EXISTS (
               SELECT 1 FROM cloudflare_connections AS connection
               WHERE connection.credential_handle = credential.handle
             )
           ORDER BY credential.created_at, credential.handle
           LIMIT ?
         )
           AND NOT EXISTS (
             SELECT 1 FROM cloudflare_authorizations AS authorization
             WHERE authorization.credential_handle = cloudflare_credentials.handle
           )
           AND NOT EXISTS (
             SELECT 1 FROM cloudflare_connections AS connection
             WHERE connection.credential_handle = cloudflare_credentials.handle
           )`,
      )
      .bind(credentialCreatedBefore, credentialCreatedBefore, limit),
  ]);
}

export async function pruneCloudflareAuthDataBestEffort(db: D1Database): Promise<void> {
  try {
    await pruneCloudflareAuthData(db);
  } catch {
    console.error('Unable to prune expired Cloudflare authorization data');
  }
}
