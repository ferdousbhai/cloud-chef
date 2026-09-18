import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';

/**
 * Erase operator-held account data and revoke the OAuth grant. Resources deployed into the user's
 * Cloudflare account remain theirs. Revoking the connection first also makes any in-flight
 * provisioning Workflow fail its connection check before its next provider operation.
 */
export async function eraseControlPlaneAccount(args: {
  env: Env;
  userId: string;
  vault?: D1CloudflareCredentialVault;
}): Promise<{ cloudflareAuthorizationRevoked: boolean }> {
  const db = args.env.DB;
  // Project resource cleanup runs in the user workspace and needs the Cloudflare authorization
  // revoked here, so it cannot be drained from the control plane: the project GC receipts live in
  // the workspace database, which this erasure deliberately never touches. The settings UI names
  // the ordering this implies — delete projects and let their scheduled cleanup finish first.
  const credentialHandle = await revokeConnection(db, args.userId);
  const vault = credentialHandle !== null ? (args.vault ?? safeCredentialVault(args.env)) : null;
  const cloudflareAuthorizationRevoked =
    vault && credentialHandle !== null
      ? await vault.revokeOAuthCredential(credentialHandle).catch(() => {
          console.warn('Unable to revoke the Cloudflare grant during account erasure');
          return false;
        })
      : false;

  await db.batch([
    db.prepare('DELETE FROM cloudflare_oauth_states WHERE authenticated_user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM user_computer_runtimes WHERE user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM cloudflare_auth_sessions WHERE user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM cloudflare_connections WHERE user_id = ?').bind(args.userId),
    db
      .prepare(
        `DELETE FROM cloudflare_credentials
         WHERE handle = ? AND NOT EXISTS (
           SELECT 1 FROM cloudflare_connections WHERE credential_handle = ?
         )`,
      )
      .bind(credentialHandle, credentialHandle),
    db.prepare('DELETE FROM "user" WHERE id = ?').bind(args.userId),
  ]);

  return { cloudflareAuthorizationRevoked };
}

async function revokeConnection(db: D1Database, userId: string): Promise<string | null> {
  const revoked = await db
    .prepare(
      `UPDATE cloudflare_connections SET status = 'revoked', updated_at = ?
       WHERE user_id = ? AND status = 'active'
       RETURNING credential_handle`,
    )
    .bind(Date.now(), userId)
    .first<{ credential_handle: string | null }>();
  const connection =
    revoked ??
    (await db
      .prepare('SELECT credential_handle FROM cloudflare_connections WHERE user_id = ?')
      .bind(userId)
      .first<{ credential_handle: string | null }>());
  return connection?.credential_handle ?? null;
}

function safeCredentialVault(env: Env): D1CloudflareCredentialVault | null {
  try {
    return D1CloudflareCredentialVault.fromEnv(env);
  } catch (error) {
    console.warn(
      'Cloudflare credential configuration is unavailable, so the grant must be revoked from the ' +
        'Cloudflare dashboard',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
