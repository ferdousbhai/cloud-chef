type ConversationAgentInitializationContext = Pick<DurableObjectState, 'blockConcurrencyWhile' | 'storage'>;

/**
 * The agent's own SQLite tables, each created only when missing. An agent created before this carries
 * them already, beside the migrations table its earlier versioned schema kept, which nothing reads.
 */
const SCHEMA_STATEMENTS: readonly string[] = [
  `
    CREATE TABLE IF NOT EXISTS builder_context_state (
      id TEXT PRIMARY KEY,
      summary TEXT,
      from_message_id TEXT,
      to_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
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
  `
    CREATE TABLE IF NOT EXISTS builder_cloudflare_executions (
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
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS builder_cloudflare_executions_status_expiry
    ON builder_cloudflare_executions (status, expires_at)
  `,
];

/**
 * Gate ConversationAgent startup on its local SQLite schema. Cloudflare delivers no
 * other events to this Durable Object until the callback resolves.
 */
export function initializeConversationAgentSchema(ctx: ConversationAgentInitializationContext): void {
  ctx.blockConcurrencyWhile(async () => {
    for (const statement of SCHEMA_STATEMENTS) {
      ctx.storage.sql.exec(statement);
    }
  });
}
