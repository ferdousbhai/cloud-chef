import type { SqlProvider } from 'agents/context';
import type { ContextCompaction } from './context-compaction';

const CONTEXT_ID = 'active';

type ContextStateRow = {
  summary: string | null;
  from_message_id: string | null;
  to_message_id: string | null;
};

/** Persists the single summary overlay owned by one transcript Agent. */
export class DurableObjectContextCompactionRepository {
  constructor(private readonly db: SqlProvider) {}

  getCompaction(): ContextCompaction | null {
    return this.read(CONTEXT_ID);
  }

  saveCompaction(compaction: ContextCompaction): void {
    const updatedAt = new Date().toISOString();
    void this.db.sql`
      INSERT INTO builder_context_state (
        id, summary, from_message_id, to_message_id, created_at, updated_at
      ) VALUES (
        ${CONTEXT_ID}, ${compaction.summary}, ${compaction.fromMessageId}, ${compaction.toMessageId},
        ${updatedAt}, ${updatedAt}
      ) ON CONFLICT(id) DO UPDATE SET
        summary = excluded.summary,
        from_message_id = excluded.from_message_id,
        to_message_id = excluded.to_message_id,
        updated_at = excluded.updated_at
    `;
  }

  saveCompactionIfCurrent(compaction: ContextCompaction, expected: ContextCompaction | null): boolean {
    const current = this.getCompaction();
    if (
      current?.summary !== expected?.summary ||
      current?.fromMessageId !== expected?.fromMessageId ||
      current?.toMessageId !== expected?.toMessageId
    ) {
      return false;
    }
    this.saveCompaction(compaction);
    return true;
  }

  private read(id: string): ContextCompaction | null {
    const row = this.db.sql<ContextStateRow>`
      SELECT summary, from_message_id, to_message_id
      FROM builder_context_state
      WHERE id = ${id}
      LIMIT 1
    `[0];
    if (!row) {
      return null;
    }
    if (!row.summary || !row.from_message_id || !row.to_message_id) {
      throw new Error('Stored context compaction is invalid.');
    }
    return {
      summary: row.summary,
      fromMessageId: row.from_message_id,
      toMessageId: row.to_message_id,
    };
  }
}
