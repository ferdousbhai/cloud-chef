import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_GC_GRACE_PERIOD_MS,
  AGENT_GC_RETRY_BASE_MS,
  AGENT_GC_SWEEP_LIMIT,
  prepareAgentGcCandidatesStatement,
  sweepAgentGcCandidates,
} from './agent-gc.server';

describe('BuilderAgent garbage collection', () => {
  it('durably schedules every deterministic generation before removing a subchat range receipt', async () => {
    const database = new AgentGcDatabase([candidate({ max_generation: 1 })]);

    await expect(sweepAgentGcCandidates(database.env, { now: 100 })).resolves.toBeUndefined();
    expect(database.scheduleDestroy).toHaveBeenLastCalledWith('chat', 'owner');
    expect(database.candidates[0]).toMatchObject({ next_generation: 1, attempts: 0, not_before: 100 });

    await expect(sweepAgentGcCandidates(database.env, { now: 100 })).resolves.toBeUndefined();
    expect(database.scheduleDestroy).toHaveBeenLastCalledWith('chat--transcript-0-1', 'owner');
    expect(database.candidates).toEqual([]);
    expect(database.destroy).not.toHaveBeenCalled();
  });

  it('retains a generation when its durable destroy schedule is not accepted', async () => {
    const database = new AgentGcDatabase([candidate({ attempts: 2 })]);
    database.scheduleDestroy.mockRejectedValueOnce(new Error('transient RPC failure'));

    await expect(sweepAgentGcCandidates(database.env, { now: 1_000 })).resolves.toBeUndefined();

    expect(database.candidates[0]).toMatchObject({
      next_generation: 0,
      attempts: 3,
      not_before: 1_000 + AGENT_GC_RETRY_BASE_MS * 4,
    });
  });

  it('does not advance the outbox until the Agent accepts its durable destroy schedule', async () => {
    const database = new AgentGcDatabase([candidate()]);
    let acceptSchedule!: () => void;
    database.scheduleDestroy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acceptSchedule = resolve;
        }),
    );

    const sweep = sweepAgentGcCandidates(database.env, { now: 100 });
    await vi.waitFor(() => expect(database.scheduleDestroy).toHaveBeenCalledOnce());
    expect(database.candidates).toHaveLength(1);

    acceptSchedule();
    await expect(sweep).resolves.toBeUndefined();
    expect(database.candidates).toEqual([]);
  });

  it('does not sweep a freshly deleted chat during its in-flight request grace period', async () => {
    const database = new AgentGcDatabase([candidate({ not_before: 100 + AGENT_GC_GRACE_PERIOD_MS })]);

    await expect(sweepAgentGcCandidates(database.env, { now: 100 })).resolves.toBeUndefined();
    expect(database.scheduleDestroy).not.toHaveBeenCalled();
    expect(database.candidates).toHaveLength(1);
  });

  it('caps concurrent Agent destruction work even when a caller asks for more', async () => {
    const database = new AgentGcDatabase(
      Array.from({ length: AGENT_GC_SWEEP_LIMIT + 3 }, (_, index) =>
        candidate({ chat_id: `chat-row-${index}`, initial_id: `chat-${index}` }),
      ),
    );

    await expect(sweepAgentGcCandidates(database.env, { now: 100, limit: 999 })).resolves.toBeUndefined();
    expect(database.scheduleDestroy).toHaveBeenCalledTimes(AGENT_GC_SWEEP_LIMIT);
    expect(database.candidates).toHaveLength(3);
  });
});

describe('BuilderAgent garbage collection receipts', () => {
  it('applies the full grace period to normal chat deletion candidates', () => {
    const bind = vi.fn(() => ({}) as D1PreparedStatement);
    let sql = '';
    const db = {
      prepare: vi.fn((statement: string) => {
        sql = statement;
        return { bind };
      }),
    } as unknown as D1Database;

    prepareAgentGcCandidatesStatement(db, { initialId: 'chat', ownerId: 'owner', now: 1_000 });

    expect(bind).toHaveBeenCalledWith(1_000 + AGENT_GC_GRACE_PERIOD_MS, 1_000, 'owner', 'chat');
    expect(sql).not.toContain('has_messages');
  });

  it('applies the full grace period to empty-chat discard candidates', () => {
    const bind = vi.fn(() => ({}) as D1PreparedStatement);
    let sql = '';
    const db = {
      prepare: vi.fn((statement: string) => {
        sql = statement;
        return { bind };
      }),
    } as unknown as D1Database;

    prepareAgentGcCandidatesStatement(db, { ownerId: 'owner', initialId: 'chat', now: 2_000, requireEmpty: true });

    expect(bind).toHaveBeenCalledWith(2_000 + AGENT_GC_GRACE_PERIOD_MS, 2_000, 'owner', 'chat');
    expect(sql).toContain('chats.has_messages = 0');
  });
});

type Candidate = {
  chat_id: string;
  initial_id: string;
  owner_id: string;
  subchat_index: number;
  next_generation: number;
  max_generation: number;
  not_before: number;
  attempts: number;
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    chat_id: 'chat-row',
    initial_id: 'chat',
    owner_id: 'owner',
    subchat_index: 0,
    next_generation: 0,
    max_generation: 0,
    not_before: 50,
    attempts: 0,
    ...overrides,
  };
}

class AgentGcDatabase {
  readonly scheduleDestroy = vi.fn<(name: string, ownerId: string) => Promise<void>>(
    async (_name: string, _ownerId: string) => undefined,
  );
  readonly destroy = vi.fn(async (_name: string) => undefined);

  constructor(readonly candidates: Candidate[]) {}

  readonly env = {
    DB: {
      prepare: (query: string) => ({
        bind: (...values: unknown[]) => ({
          all: async () => this.all(query, values),
          run: async () => this.run(query, values),
        }),
      }),
    },
    BuilderAgent: {
      getByName: (name: string) => ({
        scheduleDestroyForGc: (ownerId: string) => this.scheduleDestroy(name, ownerId),
        destroy: () => this.destroy(name),
      }),
    },
  } as unknown as Pick<Env, 'BuilderAgent' | 'DB'>;

  private all(query: string, values: unknown[]) {
    if (!query.includes('FROM agent_gc_candidates')) {
      return { results: [] };
    }
    const [now, limit] = values as [number, number];
    return {
      results: this.candidates
        .filter((item) => item.not_before <= now)
        .sort(
          (left, right) =>
            left.not_before - right.not_before ||
            left.chat_id.localeCompare(right.chat_id) ||
            left.subchat_index - right.subchat_index,
        )
        .slice(0, limit)
        .map((item) => ({ ...item })),
    };
  }

  private run(query: string, values: unknown[]): D1Result {
    if (query.includes('DELETE FROM agent_gc_candidates')) {
      const [chatId, subchatIndex, nextGeneration, notBefore] = values as [string, number, number, number];
      const index = this.find(chatId, subchatIndex, nextGeneration, notBefore);
      if (index < 0) {
        return changed(0);
      }
      this.candidates.splice(index, 1);
      return changed(1);
    }

    if (query.includes('next_generation = next_generation + 1')) {
      const [now, chatId, subchatIndex, nextGeneration, notBefore] = values as [number, string, number, number, number];
      const index = this.find(chatId, subchatIndex, nextGeneration, notBefore);
      if (index < 0) {
        return changed(0);
      }
      Object.assign(this.candidates[index], { next_generation: nextGeneration + 1, attempts: 0, not_before: now });
      return changed(1);
    }

    if (query.includes('attempts = attempts + 1')) {
      const [retryAt, chatId, subchatIndex, nextGeneration, notBefore] = values as [
        number,
        string,
        number,
        number,
        number,
      ];
      const index = this.find(chatId, subchatIndex, nextGeneration, notBefore);
      if (index < 0) {
        return changed(0);
      }
      Object.assign(this.candidates[index], {
        attempts: this.candidates[index].attempts + 1,
        not_before: retryAt,
      });
      return changed(1);
    }

    return changed(0);
  }

  private find(chatId: string, subchatIndex: number, nextGeneration: number, notBefore: number): number {
    return this.candidates.findIndex(
      (item) =>
        item.chat_id === chatId &&
        item.subchat_index === subchatIndex &&
        item.next_generation === nextGeneration &&
        item.not_before === notBefore,
    );
  }
}

function changed(changes: number): D1Result {
  return { success: true, meta: { changes } } as D1Result;
}
