import { copyJson, type JsonValue } from '@earendil-works/chord';
import { z } from 'zod';

/**
 * A chat from before pi-durable kept its messages in the Agents SDK's session tables, written by AI Chat. Each one is
 * moved once into the pi-durable transcript as a display-only entry (`cloudchef.legacy`), which the model never sees:
 * such a chat goes on in a fresh context, and the chat still shows what came before. The old tables stay, unused,
 * so a rollback to the release before keeps every chat; a later release drops them. The runtime's maintenance starts
 * each agent once (`legacy-chat-moves.server.ts`), so a chat no one opens moves too.
 */

type LegacySql = Pick<DurableObjectStorage['sql'], 'exec'>;

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
