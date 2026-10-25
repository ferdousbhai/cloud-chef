import { z } from 'zod';
import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { findMembership, isActiveAdmin } from './organization-access.server';

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
  return isActiveAdmin(await findMembership(db, connection.orgId, userId));
}

/** What an account's admin chose for its models. */
export type BuilderModelSettings = {
  /** The model its builders start on; null for CloudChef's default. */
  defaultModelId: string | null;
  /** The models the picker offers; null for every compatible model, including ones added later. */
  allowedModelIds: string[] | null;
};

const storedAllowedModelIdsSchema = z.array(z.string());

/** The account's model choices, as its admin made them. */
export async function readBuilderModelSettings(db: D1Database, connectionId: string): Promise<BuilderModelSettings> {
  const row = await db
    .prepare(
      'SELECT default_builder_model AS model, allowed_builder_models_json AS allowed FROM cloudflare_connections WHERE id = ?',
    )
    .bind(connectionId)
    .first<{ model: string | null; allowed: string | null }>();
  return { defaultModelId: row?.model ?? null, allowedModelIds: parseAllowedModelIds(row?.allowed ?? null) };
}

/**
 * A stored list that cannot be read allows nothing rather than everything: only CloudChef writes it,
 * and a list it cannot read must not reopen the picker to models the admin left out.
 */
function parseAllowedModelIds(stored: string | null): string[] | null {
  if (stored === null) {
    return null;
  }
  try {
    return storedAllowedModelIdsSchema.safeParse(JSON.parse(stored)).data ?? [];
  } catch {
    return [];
  }
}

/**
 * Sets the model the account's builders start on, while the account's allowed models include it (the
 * pinned model standing for null), in one statement, so no other change can slip between the check
 * and the write. False when the allowed models do not include it.
 */
export async function setDefaultBuilderModel(
  db: D1Database,
  connectionId: string,
  modelId: string | null,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE cloudflare_connections SET default_builder_model = ?1
       WHERE id = ?2
         AND (allowed_builder_models_json IS NULL
           OR EXISTS (SELECT 1 FROM json_each(allowed_builder_models_json) WHERE value = COALESCE(?1, ?3)))`,
    )
    .bind(modelId, connectionId, CLOUDFLARE_WORKERS_AI_MODEL)
    .run();
  return result.meta.changes > 0;
}

/**
 * Sets the models the account's picker offers (null for every compatible one) while they include the
 * account's default (the pinned model when none is chosen), in one statement. False when they do not.
 */
export async function setAllowedBuilderModels(
  db: D1Database,
  connectionId: string,
  modelIds: readonly string[] | null,
): Promise<boolean> {
  const stored = modelIds === null ? null : JSON.stringify([...new Set(modelIds)]);
  const result = await db
    .prepare(
      `UPDATE cloudflare_connections SET allowed_builder_models_json = ?1
       WHERE id = ?2
         AND (?1 IS NULL
           OR EXISTS (SELECT 1 FROM json_each(?1) WHERE value = COALESCE(default_builder_model, ?3)))`,
    )
    .bind(stored, connectionId, CLOUDFLARE_WORKERS_AI_MODEL)
    .run();
  return result.meta.changes > 0;
}
