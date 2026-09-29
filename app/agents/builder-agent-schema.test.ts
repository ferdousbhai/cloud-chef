import { describe, expect, it, vi } from 'vitest';
import { initializeBuilderAgentSchema, runBuilderAgentSchemaMigrations } from './builder-agent-schema';

type MigrationRow = { version: number; name: string };

class TestSchemaStorage {
  readonly applied: MigrationRow[] = [];
  readonly statements: string[] = [];
  transactionCount = 0;

  readonly sql = {
    exec: <T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T> => {
      const normalized = query.replace(/\s+/g, ' ').trim();
      this.statements.push(normalized);
      if (normalized.startsWith('SELECT version, name')) {
        return [...this.applied] as T[];
      }
      if (normalized.startsWith('INSERT INTO _ghostbuild_builder_schema_migrations')) {
        this.applied.push({ version: Number(bindings[0]), name: String(bindings[1]) });
      }
      return [];
    },
  };

  transactionSync<T>(closure: () => T): T {
    this.transactionCount += 1;
    return closure();
  }
}

describe('BuilderAgent schema migrations', () => {
  it('applies all migrations in version order and records them atomically', () => {
    const storage = new TestSchemaStorage();

    runBuilderAgentSchemaMigrations(storage as never);

    expect(storage.applied).toEqual([
      { version: 1, name: 'create_builder_turns' },
      { version: 2, name: 'create_builder_context_state' },
      { version: 3, name: 'create_builder_tool_replays' },
      { version: 4, name: 'remove_builder_tool_replays' },
      { version: 5, name: 'persist_builder_identity' },
      { version: 6, name: 'remove_builder_turns' },
      { version: 7, name: 'create_cloudflare_execution_approvals' },
      { version: 8, name: 'clear_cloudflare_mcp_execute_proposals' },
    ]);
    expect(storage.transactionCount).toBe(8);
    expect(storage.statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS builder_turns'))).toBe(
      true,
    );
    expect(
      storage.statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS builder_context_state')),
    ).toBe(true);
    expect(storage.statements.some((statement) => statement.includes('builder_workspace_files'))).toBe(false);
    expect(storage.statements.some((statement) => statement.includes('builder_preview_jobs'))).toBe(false);
    expect(storage.statements).toContain('DROP TABLE IF EXISTS builder_workspace_tool_results');
    expect(
      storage.statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS builder_identity')),
    ).toBe(true);
    expect(storage.statements).toContain('DROP TABLE IF EXISTS builder_turns');
    expect(
      storage.statements.some((statement) =>
        statement.includes('CREATE TABLE IF NOT EXISTS builder_cloudflare_executions'),
      ),
    ).toBe(true);
  });

  it('is idempotent after the current schema has been recorded', () => {
    const storage = new TestSchemaStorage();
    runBuilderAgentSchemaMigrations(storage as never);

    storage.statements.length = 0;
    storage.transactionCount = 0;
    runBuilderAgentSchemaMigrations(storage as never);

    expect(storage.transactionCount).toBe(0);
    expect(storage.statements).toHaveLength(2);
  });

  it('advances an existing replay-table schema without rewriting published history', () => {
    const storage = new TestSchemaStorage();
    storage.applied.push(
      { version: 1, name: 'create_builder_turns' },
      { version: 2, name: 'create_builder_context_state' },
      { version: 3, name: 'create_builder_tool_replays' },
    );

    runBuilderAgentSchemaMigrations(storage as never);

    expect(storage.applied.slice(-5)).toEqual([
      { version: 4, name: 'remove_builder_tool_replays' },
      { version: 5, name: 'persist_builder_identity' },
      { version: 6, name: 'remove_builder_turns' },
      { version: 7, name: 'create_cloudflare_execution_approvals' },
      { version: 8, name: 'clear_cloudflare_mcp_execute_proposals' },
    ]);
    expect(storage.transactionCount).toBe(5);
    expect(storage.statements).toContain('DROP TABLE IF EXISTS builder_workspace_tool_results');
  });

  it('fails closed when a deployed database has an unknown migration history', () => {
    const storage = new TestSchemaStorage();
    storage.applied.push({ version: 1, name: 'unexpected_migration' });

    expect(() => runBuilderAgentSchemaMigrations(storage as never)).toThrow(
      'Unsupported BuilderAgent schema migration history at version 1 (unexpected_migration).',
    );
    expect(storage.transactionCount).toBe(0);
  });

  it('registers migration work with the constructor concurrency gate', async () => {
    const storage = new TestSchemaStorage();
    let initialization: Promise<unknown> | undefined;
    const blockConcurrencyWhile = vi.fn((callback: () => Promise<unknown>) => {
      initialization = callback();
    });

    initializeBuilderAgentSchema({ storage: storage as never, blockConcurrencyWhile } as never);

    expect(blockConcurrencyWhile).toHaveBeenCalledOnce();
    await expect(initialization).resolves.toBeUndefined();
    expect(storage.applied).toHaveLength(8);
  });
});
