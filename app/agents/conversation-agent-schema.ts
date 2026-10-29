type ConversationAgentInitializationContext = Pick<DurableObjectState, 'blockConcurrencyWhile' | 'storage'>;

/** A change to the Cloudflare account an agent's command asked for, and what became of it. */
const CLOUDFLARE_EXECUTIONS_COLUMNS = `
      execution_id TEXT PRIMARY KEY,
      tool_call_id TEXT NOT NULL,
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
      status TEXT NOT NULL CHECK (status IN (
        'awaiting_approval', 'approved', 'rejected', 'executing',
        'succeeded', 'failed', 'indeterminate', 'expired'
      )),
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      expires_at INTEGER NOT NULL,
      outcome_json TEXT
`;

/**
 * The agent's own SQLite tables, each created only when missing. An agent created before this carries
 * them already, beside the migrations table its earlier versioned schema kept, which nothing reads.
 */
const SCHEMA_STATEMENTS: readonly string[] = [
  // The context compaction store of the builder before pi-durable; nothing reads it.
  `DROP TABLE IF EXISTS builder_context_state`,
  `
    CREATE TABLE IF NOT EXISTS builder_identity (
      id TEXT PRIMARY KEY CHECK (id = 'active'),
      owner_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      chat_initial_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      subchat_index INTEGER NOT NULL,
      parent_agent_name TEXT,
      created_at TEXT NOT NULL
    )
  `,
  `CREATE TABLE IF NOT EXISTS builder_cloudflare_executions (${CLOUDFLARE_EXECUTIONS_COLUMNS})`,
  `
    CREATE INDEX IF NOT EXISTS builder_cloudflare_executions_status_expiry
    ON builder_cloudflare_executions (status, expires_at)
  `,
  `
    CREATE INDEX IF NOT EXISTS builder_cloudflare_executions_tool_call
    ON builder_cloudflare_executions (tool_call_id, created_at)
  `,
];

/**
 * A command once had at most one change (`tool_call_id` was UNIQUE); it may now ask for several, each approved in
 * turn. SQLite can't drop a column's constraint in place, so an agent made before this rebuilds the table once,
 * keeping every change it holds, before the statements above add its indexes back.
 */
function allowSeveralChangesPerCommand(storage: ConversationAgentInitializationContext['storage']): void {
  const table = [
    ...storage.sql.exec<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'builder_cloudflare_executions'`,
    ),
  ][0];
  if (!table || !/tool_call_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/iu.test(table.sql)) {
    return;
  }
  storage.transactionSync(() => {
    storage.sql.exec(`CREATE TABLE builder_cloudflare_executions_next (${CLOUDFLARE_EXECUTIONS_COLUMNS})`);
    storage.sql.exec(`INSERT INTO builder_cloudflare_executions_next SELECT * FROM builder_cloudflare_executions`);
    storage.sql.exec(`DROP TABLE builder_cloudflare_executions`);
    storage.sql.exec(`ALTER TABLE builder_cloudflare_executions_next RENAME TO builder_cloudflare_executions`);
  });
}

/**
 * Gate ConversationAgent startup on its local SQLite schema. Cloudflare delivers no
 * other events to this Durable Object until the callback resolves.
 */
export function initializeConversationAgentSchema(ctx: ConversationAgentInitializationContext): void {
  ctx.blockConcurrencyWhile(async () => {
    allowSeveralChangesPerCommand(ctx.storage);
    for (const statement of SCHEMA_STATEMENTS) {
      ctx.storage.sql.exec(statement);
    }
  });
}
