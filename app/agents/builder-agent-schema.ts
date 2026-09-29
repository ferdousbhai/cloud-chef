type BuilderAgentSchemaStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

type BuilderAgentInitializationContext = Pick<DurableObjectState, 'blockConcurrencyWhile' | 'storage'>;

type SchemaMigration = {
  version: number;
  name: string;
  apply(sql: SqlStorage): void;
};

const MIGRATION_TABLE = '_ghostbuild_builder_schema_migrations';

const migrations: readonly SchemaMigration[] = [
  {
    version: 1,
    name: 'create_builder_turns',
    apply(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS builder_turns (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          chat_initial_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          continuation INTEGER NOT NULL,
          first_user_message INTEGER NOT NULL,
          message_count INTEGER NOT NULL,
          last_user_message_preview TEXT,
          recovery_incident_id TEXT,
          recovery_attempt INTEGER,
          recovery_kind TEXT,
          partial_text_length INTEGER,
          error TEXT
        )
      `);
    },
  },
  {
    version: 2,
    name: 'create_builder_context_state',
    apply(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS builder_context_state (
          id TEXT PRIMARY KEY,
          summary TEXT,
          from_message_id TEXT,
          to_message_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    // Published migration history is immutable even though replay ownership
    // has moved to the user-owned ProjectWorkspace Durable Object.
    version: 3,
    name: 'create_builder_tool_replays',
    apply(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS builder_workspace_tool_results (
          tool_call_id TEXT PRIMARY KEY,
          tool_name TEXT NOT NULL,
          args_sha256 TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    },
  },
  {
    version: 4,
    name: 'remove_builder_tool_replays',
    apply(sql) {
      sql.exec('DROP TABLE IF EXISTS builder_workspace_tool_results');
    },
  },
  {
    version: 5,
    name: 'persist_builder_identity',
    apply(sql) {
      sql.exec(`
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
      `);
    },
  },
  {
    version: 6,
    name: 'remove_builder_turns',
    apply(sql) {
      sql.exec('DROP TABLE IF EXISTS builder_turns');
    },
  },
  {
    version: 7,
    name: 'create_cloudflare_execution_approvals',
    apply(sql) {
      sql.exec(`
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
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS builder_cloudflare_executions_status_expiry
        ON builder_cloudflare_executions (status, expires_at)
      `);
    },
  },
  {
    version: 8,
    name: 'clear_cloudflare_mcp_execute_proposals',
    apply(sql) {
      // Approvals now hold one exact API request instead of MCP execute code. Code proposals can no
      // longer run, and every terminal outcome is already persisted into its transcript tool part.
      sql.exec('DELETE FROM builder_cloudflare_executions');
    },
  },
];

type AppliedMigration = {
  version: number;
  name: string;
};

/**
 * Gate BuilderAgent startup on its local SQLite schema. Cloudflare delivers no
 * other events to this Durable Object until the callback resolves.
 */
export function initializeBuilderAgentSchema(ctx: BuilderAgentInitializationContext): void {
  ctx.blockConcurrencyWhile(async () => {
    runBuilderAgentSchemaMigrations(ctx.storage);
  });
}
/** Apply every pending BuilderAgent schema change exactly once and in order. */
export function runBuilderAgentSchemaMigrations(storage: BuilderAgentSchemaStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = [
    ...storage.sql.exec<AppliedMigration>(`
      SELECT version, name
      FROM ${MIGRATION_TABLE}
      ORDER BY version ASC
    `),
  ];
  assertCompatibleMigrationHistory(applied);

  for (const migration of migrations.slice(applied.length)) {
    storage.transactionSync(() => {
      migration.apply(storage.sql);
      storage.sql.exec(
        `INSERT INTO ${MIGRATION_TABLE} (version, name) VALUES (?, ?)`,
        migration.version,
        migration.name,
      );
    });
  }
}

function assertCompatibleMigrationHistory(applied: readonly AppliedMigration[]): void {
  for (const [index, recorded] of applied.entries()) {
    const expected = migrations[index];
    if (!expected || recorded.version !== expected.version || recorded.name !== expected.name) {
      throw new Error(
        `Unsupported BuilderAgent schema migration history at version ${recorded.version} (${recorded.name}).`,
      );
    }
  }
}
