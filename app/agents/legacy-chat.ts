import { copyJson, type JsonValue } from '@earendil-works/chord';
import { z } from 'zod';

/**
 * A chat from before pi-durable kept its messages in the Agents SDK's session tables, written by AI Chat. Each one is
 * moved once into the pi-durable transcript as a display-only entry (`cloudchef.legacy`), which the model never sees:
 * such a chat goes on in a fresh context, and the chat still shows what came before. The old tables are then dropped.
 */

type LegacySql = Pick<DurableObjectStorage['sql'], 'exec'>;

const LEGACY_TABLES = [
  'cf_agents_session_messages',
  'cf_agents_session_message_chunks',
  'cf_agents_session_compactions',
  'cf_agents_session_config',
  'cf_agents_session_attachment_chunks',
  'cf_agents_session_attachment_meta',
  'cf_agents_session_attachment_refs',
  'cf_ai_chat_agent_messages',
  'cf_ai_chat_agent_tool_runs',
  'cf_ai_chat_agent_tool_milestones',
  'cf_ai_chat_request_context',
] as const;

const rowSchema = z.object({ id: z.string(), content: z.string(), content_chunks: z.number() });
const chunkSchema = z.object({ content: z.string() });
const legacyMessageSchema = z.looseObject({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(z.looseObject({ type: z.string().min(1) })),
});

function tableExists(sql: LegacySql, name: string): boolean {
  return sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name).toArray().length > 0;
}

/** The old chat's messages, oldest first, as JSON; none when there is no old chat. */
export function readLegacyMessages(sql: LegacySql): JsonValue[] {
  if (!tableExists(sql, 'cf_agents_session_messages')) {
    return [];
  }
  const chunked = tableExists(sql, 'cf_agents_session_message_chunks');
  const rows = sql
    .exec(
      `SELECT id, content, content_chunks FROM cf_agents_session_messages
       WHERE session_id = '' AND type = 'message' ORDER BY seq ASC`,
    )
    .toArray();
  return rows.flatMap((value) => {
    const row = rowSchema.safeParse(value).data;
    if (!row) {
      return [];
    }
    const rest =
      row.content_chunks > 0 && chunked
        ? sql
            .exec(
              `SELECT content FROM cf_agents_session_message_chunks WHERE session_id = '' AND id = ? ORDER BY idx ASC`,
              row.id,
            )
            .toArray()
            .map((chunk) => chunkSchema.safeParse(chunk).data?.content ?? '')
            .join('')
        : '';
    try {
      const message = legacyMessageSchema.safeParse(JSON.parse(row.content + rest)).data;
      return message ? [copyJson(message, { omitUndefinedProperties: true })] : [];
    } catch {
      return [];
    }
  });
}

/** Drops what AI Chat kept, once its messages are in the pi-durable transcript. */
export function dropLegacyChatTables(sql: LegacySql): void {
  for (const table of LEGACY_TABLES) {
    sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}
