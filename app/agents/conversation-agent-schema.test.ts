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
          const statement = database.prepare(query);
          if (statement.columns().length > 0) {
            return statement.all();
          }
          statement.run();
          return [];
        },
      },
      transactionSync<T>(callback: () => T): T {
        database.exec('BEGIN');
        try {
          const result = callback();
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },
    },
    blockConcurrencyWhile(callback: () => Promise<void>) {
      gates.push(callback());
    },
  };
  // SAFETY: the schema uses only `blockConcurrencyWhile`, `transactionSync` and `storage.sql.exec` without
  // bindings, which this implements.
  return { ctx: ctx as never, gates };
}

function schemaObjects(database: DatabaseSync): string[] {
  return database
    .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'builder_%' ORDER BY name`)
    .all()
    .map((row) => String(row.name));
}

/** The Cloudflare changes table as an agent made before a command could ask for several changes. */
const ONE_CHANGE_PER_COMMAND_TABLE = `
  CREATE TABLE builder_cloudflare_executions (
    execution_id TEXT PRIMARY KEY,
    tool_call_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    connection_generation INTEGER NOT NULL,
    oauth_scope_grant_status TEXT NOT NULL CHECK (oauth_scope_grant_status IN ('core', 'partial', 'full')),
    transcript_agent_name TEXT NOT NULL,
    transcript_chat_initial_id TEXT NOT NULL,
    transcript_generation INTEGER NOT NULL,
    transcript_subchat_index INTEGER NOT NULL,
    transcript_parent_agent_name TEXT,
    execute_input_json TEXT NOT NULL,
    proposal_sha256 TEXT NOT NULL CHECK (length(proposal_sha256) = 64),
    risk_reasons_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    expires_at INTEGER NOT NULL,
    outcome_json TEXT
  );
  CREATE INDEX builder_cloudflare_executions_status_expiry ON builder_cloudflare_executions (status, expires_at);
`;

function insertChange(database: DatabaseSync, executionId: string, toolCallId: string) {
  database
    .prepare(
      `INSERT INTO builder_cloudflare_executions (execution_id, tool_call_id, user_id, account_id, connection_id,
         connection_generation, oauth_scope_grant_status, transcript_agent_name, transcript_chat_initial_id,
         transcript_generation, transcript_subchat_index, execute_input_json, proposal_sha256, risk_reasons_json,
         status, created_at, expires_at)
       VALUES (?, ?, 'user', 'account', 'connection', 1, 'core', 'agent', 'chat', 0, 0, '{}', ?, '[]',
         'succeeded', 1, 2)`,
    )
    .run(executionId, toolCallId, 'a'.repeat(64));
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
      'builder_cloudflare_executions_tool_call',
      'builder_context_state',
      'builder_identity',
    ]);
  });

  it('starts an agent created under the versioned schema, keeping what it holds', async () => {
    const database = new DatabaseSync(':memory:');
    const first = agentContext(database);
    initializeConversationAgentSchema(first.ctx);
    await Promise.all(first.gates);
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

  it('lets a command made before several changes per command keep its changes, and ask for more', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(ONE_CHANGE_PER_COMMAND_TABLE);
    insertChange(database, 'execution-1', 'exec-1');

    const { ctx, gates } = agentContext(database);
    initializeConversationAgentSchema(ctx);
    await Promise.all(gates);
    insertChange(database, 'execution-2', 'exec-1');

    expect(
      database.prepare('SELECT execution_id FROM builder_cloudflare_executions ORDER BY execution_id').all(),
    ).toEqual([{ execution_id: 'execution-1' }, { execution_id: 'execution-2' }]);
    expect(schemaObjects(database)).toContain('builder_cloudflare_executions_status_expiry');

    // Starting again leaves the rebuilt table as it is.
    const again = agentContext(database);
    initializeConversationAgentSchema(again.ctx);
    await Promise.all(again.gates);
    expect(database.prepare('SELECT COUNT(*) AS count FROM builder_cloudflare_executions').all()).toEqual([
      { count: 2 },
    ]);
  });
});
