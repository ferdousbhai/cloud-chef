import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { findMembership } from './organization-access.server';

/**
 * Who may choose the account's models: the person whose own account it is, or an active admin of the
 * team that owns it.
 */
export async function canManageModels(
  db: D1Database,
  userId: string,
  connection: Pick<CloudflareConnection, 'userId' | 'orgId'>,
): Promise<boolean> {
  if (connection.userId !== null) {
    return connection.userId === userId;
  }
  if (connection.orgId === null) {
    return false;
  }
  const membership = await findMembership(db, connection.orgId, userId);
  return membership?.role === 'admin' && membership.pausedAt === null;
}

/**
 * The model an account's builders start on, as its admin chose it; null for CloudChef's default.
 */
export async function readDefaultBuilderModel(db: D1Database, connectionId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT default_builder_model AS model FROM cloudflare_connections WHERE id = ?')
    .bind(connectionId)
    .first<{ model: string | null }>();
  return row?.model ?? null;
}

export async function setDefaultBuilderModel(
  db: D1Database,
  connectionId: string,
  modelId: string | null,
): Promise<void> {
  await db
    .prepare('UPDATE cloudflare_connections SET default_builder_model = ? WHERE id = ?')
    .bind(modelId, connectionId)
    .run();
}
