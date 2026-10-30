import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userWorkspaceDatabase } from '~/test/control-plane-d1';
import { sweepLegacyChatMoves } from './legacy-chat-moves.server';

const MIGRATION = 'user-workspace-migrations/0024_legacy_chat_moves.sql';

/** A runtime upgraded with these conversations: the migration lists each one of a workspace not deleted. */
function upgradedWorkspace() {
  const { database, db } = userWorkspaceDatabase();
  database.exec(`
    DROP TABLE legacy_chat_moves;
    INSERT INTO workspaces (id, creator_id, initial_id, timestamp, is_deleted) VALUES
      ('kept', 'user-1', 'kept', '2026-10-20T00:00:00.000Z', 0),
      ('gone', 'user-1', 'gone', '2026-10-20T00:00:00.000Z', 1);
    INSERT INTO conversations (workspace_id, conversation_index, agent_name, transition_token, created_at, updated_at) VALUES
      ('kept', 0, 'kept', 't0', 1, 1),
      ('kept', 1, 'kept--transcript-1-0', 't1', 1, 1),
      ('gone', 0, 'gone', 't2', 1, 1);
  `);
  database.exec(readFileSync(MIGRATION, 'utf8'));
  const moveLegacyChat = vi.fn(async (_agentName: string) => 2);
  const env = {
    DB: db,
    ConversationAgent: { getByName: (agentName: string) => ({ moveLegacyChat: () => moveLegacyChat(agentName) }) },
  };
  const moves = () =>
    database.prepare('SELECT agent_name, moved_messages, moved_at, attempts FROM legacy_chat_moves ORDER BY 1').all();
  return { env, moveLegacyChat, moves };
}

describe('moving the chats from before pi-durable', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: 500 });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts each listed conversation's agent once, records what it moved, and then starts none", async () => {
    const { env, moveLegacyChat, moves } = upgradedWorkspace();

    await sweepLegacyChatMoves(env);
    expect(moveLegacyChat.mock.calls.map(([name]) => name).sort()).toEqual(['kept', 'kept--transcript-1-0']);
    expect(moves()).toEqual([
      { agent_name: 'kept', moved_messages: 2, moved_at: 500, attempts: 0 },
      { agent_name: 'kept--transcript-1-0', moved_messages: 2, moved_at: 500, attempts: 0 },
    ]);

    await sweepLegacyChatMoves(env);
    expect(moveLegacyChat).toHaveBeenCalledTimes(2);
  });

  it('keeps a chat that failed to move listed, logs it, and tries it again at the next run', async () => {
    const { env, moveLegacyChat, moves } = upgradedWorkspace();
    moveLegacyChat.mockImplementation(async (agentName) => {
      if (agentName === 'kept') {
        throw new Error('not reached');
      }
      return 0;
    });

    await sweepLegacyChatMoves(env);
    expect(moves()).toEqual([
      { agent_name: 'kept', moved_messages: null, moved_at: null, attempts: 1 },
      { agent_name: 'kept--transcript-1-0', moved_messages: 0, moved_at: 500, attempts: 0 },
    ]);
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), 'Unable to move an old chat', { agentName: 'kept' });

    moveLegacyChat.mockResolvedValue(3);
    await sweepLegacyChatMoves(env);
    expect(moves()[0]).toEqual({ agent_name: 'kept', moved_messages: 3, moved_at: 500, attempts: 1 });
  });
});
