import type { SqlProvider } from 'agents/context';
import { describe, expect, test } from 'vitest';
import { DurableObjectContextCompactionRepository } from './context-compaction-store';

type Row = {
  summary: string | null;
  from_message_id: string | null;
  to_message_id: string | null;
};

class TestSqlProvider implements SqlProvider {
  readonly rows = new Map<string, Row>();

  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    if (query.startsWith('SELECT summary')) {
      const row = this.rows.get(String(values[0]));
      return (row ? [row] : []) as T[];
    }
    if (query.startsWith('INSERT INTO builder_context_state')) {
      const [id, summary, from, to] = values;
      this.rows.set(String(id), {
        summary: summary === null ? null : String(summary),
        from_message_id: from === null ? null : String(from),
        to_message_id: to === null ? null : String(to),
      });
      return [];
    }
    if (query.startsWith('DELETE FROM builder_context_state')) {
      this.rows.delete(String(values[0]));
      return [];
    }
    throw new Error(`Unhandled test SQL: ${query}`);
  }
}

describe('DurableObjectContextCompactionRepository', () => {
  test('does not write an empty record when read before a compaction exists', () => {
    const db = new TestSqlProvider();
    const repository = new DurableObjectContextCompactionRepository(db);

    expect(db.rows.size).toBe(0);
    expect(repository.getCompaction()).toBeNull();
  });

  test('round-trips the Agent-owned summary overlay', () => {
    const repository = new DurableObjectContextCompactionRepository(new TestSqlProvider());
    repository.saveCompaction({
      summary: 'summary',
      fromMessageId: 'm-3',
      toMessageId: 'm-9',
    });

    expect(repository.getCompaction()).toEqual({
      summary: 'summary',
      fromMessageId: 'm-3',
      toMessageId: 'm-9',
    });
  });

  test('rejects a partial persisted summary instead of treating it as absent', () => {
    const db = new TestSqlProvider();
    db.rows.set('active', {
      summary: 'summary',
      from_message_id: 'm-1',
      to_message_id: null,
    });

    expect(() => new DurableObjectContextCompactionRepository(db).getCompaction()).toThrow(
      'Stored context compaction is invalid',
    );
  });

  test('does not let a stale background compaction overwrite a newer checkpoint', () => {
    const repository = new DurableObjectContextCompactionRepository(new TestSqlProvider());
    const first = { summary: 'first', fromMessageId: 'm-1', toMessageId: 'm-3' };
    repository.saveCompaction(first);
    repository.saveCompaction({
      summary: 'newer',
      fromMessageId: 'm-1',
      toMessageId: 'm-8',
    });

    expect(
      repository.saveCompactionIfCurrent(
        {
          summary: 'stale result',
          fromMessageId: 'm-1',
          toMessageId: 'm-5',
        },
        first,
      ),
    ).toBe(false);
    expect(repository.getCompaction()?.summary).toBe('newer');
  });
});
