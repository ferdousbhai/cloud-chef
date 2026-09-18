import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureInitialChat = vi.hoisted(() => vi.fn());
const routeAgentRequest = vi.hoisted(() => vi.fn());

vi.mock('~/lib/cloudflare/data/chat-repository.server', () => ({ ensureInitialChat }));
vi.mock('agents', () => ({ routeAgentRequest }));

import { routeUserRuntimeAgentRequest } from './agent-request-identity';

function envWithChats(chats: Array<{ creatorId: string; isDeleted?: number }> = []) {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn((ownerId: string) => ({
          first: vi.fn(async () => ({
            match_count: chats.length,
            active_match_count: chats.filter((chat) => !chat.isDeleted).length,
            has_owner_conflict: chats.some((chat) => chat.creatorId !== ownerId) ? 1 : 0,
          })),
        })),
      })),
    },
  } as unknown as Env;
}

function route(pathname: string, env: Env, userId = 'owner') {
  return routeUserRuntimeAgentRequest(new Request(`https://cloudchef.build${pathname}`), env, userId);
}

describe('user-runtime Agent routing', () => {
  beforeEach(() => {
    ensureInitialChat.mockReset().mockResolvedValue({ id: 'claimed-chat', created: true });
    routeAgentRequest.mockReset().mockResolvedValue(new Response('routed'));
  });

  it.each(['/agents/builder-agent/chat', '//agents/builder-agent/chat', '///agents//builder-agent/chat'])(
    'authorizes every empty-segment spelling PartyServer treats as the same route: %s',
    async (pathname) => {
      const database = databaseReturning({ match_count: 1, active_match_count: 1, has_owner_conflict: 0 });
      const env = { DB: database.db } as Env;
      const request = new Request(`https://cloudchef.build${pathname}`);

      await expect(routeUserRuntimeAgentRequest(request, env, 'owner-1')).resolves.toHaveProperty('status', 200);
      expect(database.values).toEqual(['owner-1', 'chat', 'chat']);
      expect(routeAgentRequest).toHaveBeenCalledWith(request, env, {
        props: { ownerId: 'owner-1', userId: 'owner-1' },
      });
    },
  );

  it.each([
    '/agents',
    '/agents/',
    '/agents/unrecognized/chat',
    '//agents//unrecognized//chat',
    '/agents/builder-agent-extra/chat',
    '/agents/BuilderAgent/chat',
    '/agents/%62uilder-agent/chat',
    '/agents/%75nrecognized/chat',
    '/agents/builder-agent',
  ])('rejects a non-BuilderAgent namespace or missing name before PartyServer routing: %s', async (pathname) => {
    expect((await route(pathname, {} as Env))?.status).toBe(404);
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it.each([
    '/agents/builder-agent/%',
    '/agents/builder-agent/%C3%28',
    '/agents/builder-agent/%ED%A0%80',
    '/agents/builder-agent/%63hat',
    '/agents/builder-agent/%2f',
    '/agents/builder-agent/%c3%a9',
  ])('rejects a malformed or noncanonical encoded BuilderAgent name: %s', async (pathname) => {
    expect((await route(pathname, {} as Env))?.status).toBe(404);
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it.each(['a'.repeat(513), '%C3%A9'.repeat(86)])('rejects an overlong canonical wire name', async (encodedName) => {
    expect((await route(`/agents/builder-agent/${encodedName}`, {} as Env))?.status).toBe(404);
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it('uses the identical encoded name for authorization and PartyServer routing', async () => {
    const database = databaseReturning({ match_count: 1, active_match_count: 1, has_owner_conflict: 0 });
    const env = { DB: database.db } as Env;
    const request = new Request('https://cloudchef.build//agents//builder-agent/%C3%A9');

    expect((await routeUserRuntimeAgentRequest(request, env, 'owner-1'))?.status).toBe(200);
    expect(database.values).toEqual(['owner-1', '%C3%A9', '%C3%A9']);
    const routedRequest = routeAgentRequest.mock.calls[0]?.[0] as Request;
    expect(new URL(routedRequest.url).pathname.split('/').filter(Boolean)[2]).toBe(database.values[1]);
  });

  it('leaves non-Agent requests for the application router', async () => {
    await expect(route('/api/health', {} as Env)).resolves.toBeNull();
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it("does not reveal another user's BuilderAgent", async () => {
    const env = envWithChats([{ creatorId: 'owner' }]);
    expect((await route('/agents/builder-agent/private-chat', env, 'attacker'))?.status).toBe(404);
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it('routes an Agent owned by the verified runtime subject', async () => {
    const env = envWithChats([{ creatorId: 'owner' }]);
    expect((await route('/agents/builder-agent/my-chat', env))?.status).toBe(200);
    expect(routeAgentRequest).toHaveBeenCalledWith(expect.any(Request), env, {
      props: { ownerId: 'owner', userId: 'owner' },
    });
  });

  it('atomically claims a new canonical root Agent name', async () => {
    const agentName = 'e59066e3-07a0-4757-aead-a736431b9218';
    expect((await route(`/agents/builder-agent/${agentName}`, envWithChats()))?.status).toBe(200);
    expect(ensureInitialChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ creatorId: 'owner', initialId: agentName }),
    );
  });

  it.each(['legacy-name', 'old--transcript-2-1'])(
    'does not provision an unrecognized non-root Agent name: %s',
    async (agentName) => {
      expect((await route(`/agents/builder-agent/${agentName}`, envWithChats()))?.status).toBe(404);
      expect(ensureInitialChat).not.toHaveBeenCalled();
    },
  );

  it('still routes an existing legacy Agent name', async () => {
    const env = envWithChats([{ creatorId: 'owner' }]);
    expect((await route('/agents/builder-agent/legacy-name', env))?.status).toBe(200);
    expect(ensureInitialChat).not.toHaveBeenCalled();
  });

  it('classifies a raced root Agent collision as not found', async () => {
    ensureInitialChat.mockRejectedValue(new Error('UNIQUE constraint failed: chat_transcripts.agent_name'));
    const agentName = 'e59066e3-07a0-4757-aead-a736431b9218';
    const prepared: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn((...values: unknown[]) => {
          prepared.push({ query, values });
          return {
            first: vi.fn(async () =>
              query.includes('COUNT(*)')
                ? { match_count: 0, active_match_count: 0, has_owner_conflict: null }
                : { creator_id: 'other-owner' },
            ),
          };
        }),
      })),
    } as unknown as D1Database;

    expect((await route(`/agents/builder-agent/${agentName}`, { DB: db } as Env))?.status).toBe(404);
    expect(prepared[1].query).toContain('LEFT JOIN chat_transcripts');
    expect(prepared[1].values).toEqual([agentName, agentName]);
  });

  it('adopts a raced root Agent claim owned by the runtime subject', async () => {
    ensureInitialChat.mockRejectedValue(new Error('UNIQUE constraint failed: chat_transcripts.agent_name'));
    const agentName = 'e59066e3-07a0-4757-aead-a736431b9218';
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () =>
            query.includes('COUNT(*)')
              ? { match_count: 0, active_match_count: 0, has_owner_conflict: null }
              : { creator_id: 'owner' },
          ),
        })),
      })),
    } as unknown as D1Database;

    expect((await route(`/agents/builder-agent/${agentName}`, { DB: db } as Env))?.status).toBe(200);
  });

  it('does not route a deleted chat', async () => {
    const env = envWithChats([{ creatorId: 'owner', isDeleted: 1 }]);
    expect((await route('/agents/builder-agent/deleted-chat', env))?.status).toBe(404);
  });

  it('allows a retry after replacing a discarded empty chat', async () => {
    const env = envWithChats([{ creatorId: 'owner', isDeleted: 1 }, { creatorId: 'owner' }]);
    expect((await route('/agents/builder-agent/retried-chat', env))?.status).toBe(200);
  });

  it('denies a name with any matching chat owned by someone else', async () => {
    const env = envWithChats([{ creatorId: 'owner' }, { creatorId: 'attacker' }]);
    expect((await route('/agents/builder-agent/colliding-chat', env))?.status).toBe(404);
  });

  it('authorizes a generation-specific transcript owned by the runtime subject', async () => {
    const database = databaseReturning({ match_count: 1, active_match_count: 1, has_owner_conflict: 0 });

    expect(
      (await route('/agents/builder-agent/chat--transcript-2-1', { DB: database.db } as Env, 'owner-1'))?.status,
    ).toBe(200);
    expect(database.query).toContain('LEFT JOIN chat_transcripts');
    expect(database.values).toEqual(['owner-1', 'chat--transcript-2-1', 'chat--transcript-2-1']);
  });
});

function databaseReturning(row: { match_count: number; active_match_count: number; has_owner_conflict: number }) {
  const state = { query: '', values: [] as unknown[] };
  return {
    get query() {
      return state.query;
    },
    get values() {
      return state.values;
    },
    db: {
      prepare(query: string) {
        state.query = query;
        return {
          bind(...values: unknown[]) {
            state.values = values;
            return { first: async () => row };
          },
        };
      },
    } as unknown as D1Database,
  };
}
