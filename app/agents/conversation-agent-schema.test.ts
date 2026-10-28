import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { initializeConversationAgentSchema } from './conversation-agent-schema';

/** A Durable Object context over SQLite, whose concurrency gate runs its callback at once. */
function agentContext(database: DatabaseSync) {
  const gates: Promise<void>[] = [];
  const ctx = {
    storage: {
      sql: {
        exec(query: string) {
          database.exec(query);
        },
      },
    },
    blockConcurrencyWhile(callback: () => Promise<void>) {
      gates.push(callback());
    },
  };
  // SAFETY: the schema uses only `blockConcurrencyWhile` and `storage.sql.exec` without bindings, which this implements.
  return { ctx: ctx as never, gates };
}

function schemaObjects(database: DatabaseSync): string[] {
  return database
    .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'builder_%' ORDER BY name`)
    .all()
    .map((row) => String(row.name));
}

describe('ConversationAgent schema', () => {
  it("creates the agent's tables behind the constructor's concurrency gate", async () => {
    const database = new DatabaseSync(':memory:');
    const { ctx, gates } = agentContext(database);

    initializeConversationAgentSchema(ctx);

    expect(gates).toHaveLength(1);
    await Promise.all(gates);
    expect(schemaObjects(database)).toEqual([
      'builder_cloudflare_executions',
      'builder_cloudflare_executions_status_expiry',
      'builder_context_state',
      'builder_identity',
    ]);
  });

  it('starts an agent created under the versioned schema, keeping what it holds', async () => {
    const database = new DatabaseSync(':memory:');
    initializeConversationAgentSchema(agentContext(database).ctx);
    database.exec(`
      CREATE TABLE _ghostbuild_builder_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO _ghostbuild_builder_schema_migrations (version, name) VALUES (8, 'clear_cloudflare_mcp_execute_proposals');
      INSERT INTO builder_identity (id, owner_id, user_id, agent_name, chat_initial_id, generation, subchat_index, created_at)
      VALUES ('active', 'owner', 'owner', 'agent', 'chat', 0, 0, 'now');
    `);

    const { ctx, gates } = agentContext(database);
    initializeConversationAgentSchema(ctx);
    await Promise.all(gates);

    expect(database.prepare('SELECT user_id FROM builder_identity').all()).toEqual([{ user_id: 'owner' }]);
  });
});
