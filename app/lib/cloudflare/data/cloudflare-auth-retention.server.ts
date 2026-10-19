const CLOUDFLARE_AUTH_RETENTION_SWEEP_LIMIT = 100;
export const UNREFERENCED_CREDENTIAL_RETENTION_MS = 24 * 60 * 60 * 1000;
/** The window of the per-address limit on sign-in emails (`EMAIL_SIGN_IN_LINKS_PER_HOUR`). */
const EMAIL_SIGN_IN_TOKEN_RETENTION_MS = 60 * 60 * 1000;

export async function pruneCloudflareAuthData(args: { db: D1Database; now?: number; limit?: number }): Promise<void> {
  const now = args.now ?? Date.now();
  const limit = args.limit ?? CLOUDFLARE_AUTH_RETENTION_SWEEP_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLOUDFLARE_AUTH_RETENTION_SWEEP_LIMIT) {
    throw new Error('Cloudflare auth retention sweep limit is invalid.');
  }
  const credentialCreatedBefore = now - UNREFERENCED_CREDENTIAL_RETENTION_MS;
  await args.db.batch([
    args.db
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
    args.db
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
    args.db
      .prepare(
        // Kept an hour after they're sent, used or not: they count toward each address's hourly limit.
        `DELETE FROM email_sign_in_tokens
         WHERE token_hash IN (
           SELECT token_hash FROM email_sign_in_tokens WHERE created_at <= ? ORDER BY created_at LIMIT ?
         )`,
      )
      .bind(now - EMAIL_SIGN_IN_TOKEN_RETENTION_MS, limit),
    args.db
      .prepare(
        `DELETE FROM google_sign_in_states
         WHERE id IN (SELECT id FROM google_sign_in_states WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
      )
      .bind(now, limit),
    args.db
      .prepare(
        `DELETE FROM cloudflare_credentials
         WHERE handle IN (
           SELECT credential.handle
           FROM cloudflare_credentials AS credential
           WHERE credential.created_at <= ?
             AND (credential.rotated_at IS NULL OR credential.rotated_at <= ?)
             AND NOT EXISTS (
               SELECT 1 FROM cloudflare_connections AS connection
               WHERE connection.credential_handle = credential.handle
             )
           ORDER BY credential.created_at, credential.handle
           LIMIT ?
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
    await pruneCloudflareAuthData({ db });
  } catch {
    console.error('Unable to prune expired Cloudflare authorization data');
  }
}
