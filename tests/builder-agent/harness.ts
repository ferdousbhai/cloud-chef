/**
 * A BuilderAgent in Node: the real class, on an in-memory Durable Object state whose SQL storage is
 * SQLite, with the runtime's own D1 (`user-workspace-migrations/`) as `env.DB`. What lies outside the
 * agent is faked at its boundary: the ProjectWorkspace (`BuilderWorkspaceApi`) and Workers AI.
 */
import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { BuilderAgent } from '~/agents/builder-agent';
import type { BuilderWorkspaceApi, BuilderWorkspaceCheckpoint } from '~/agents/builder-workspace-api';
import type { BuilderWorkspaceState } from '~/agents/builder-workspace-types';
import {
  BuilderCloudflareExecutionRepository,
  type CloudflareExecutionBinding,
} from '~/agents/builder-cloudflare-execution';
import { envWith, userWorkspaceDatabase } from '~/test/control-plane-d1';

const require = createRequire(import.meta.url);
const sqlite: typeof NodeSqlite = require('node:sqlite');

const OWNER_ID = 'owner-1';
export const AGENT_NAME = 'agent-chat-1';
export const CHAT_INITIAL_ID = 'chat-initial-1';
export const RUNTIME_VERSION = 'runtime-current';
const ACCOUNT_ID = 'account-1';

/** The runtime's own identity, as its provisioning binds it: what the Cloudflare request tools act as. */
type RuntimeIdentityBindings = {
  CLOUDCHEF_USER_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDCHEF_CONNECTION_ID: string;
  CLOUDCHEF_CONNECTION_GENERATION: string;
  CLOUDCHEF_OAUTH_SCOPE_GRANT_STATUS: string;
  CLOUDCHEF_CONTROL_PLANE_ENDPOINT: string;
  CONTROL_PLANE_SECRET: string;
};

/** The user runtime's own bindings, which `app/user-runtime-env.d.ts` keeps off the control plane's Env. */
type UserRuntimeBindings = Partial<RuntimeIdentityBindings> & { CLOUDCHEF_USER_RUNTIME: '1'; AI?: Partial<Ai> };

const RUNTIME_IDENTITY: RuntimeIdentityBindings = {
  CLOUDCHEF_USER_ID: OWNER_ID,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDCHEF_CONNECTION_ID: 'connection-1',
  CLOUDCHEF_CONNECTION_GENERATION: '1',
  CLOUDCHEF_OAUTH_SCOPE_GRANT_STATUS: 'full',
  CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://control-plane.test',
  CONTROL_PLANE_SECRET: 'runtime-secret',
};

/** The parts of `SqlStorageCursor` the Agents SDK and BuilderAgent read. */
function cursor(rows: Record<string, SQLInputValue>[], written: number) {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) {
        throw new Error(`Expected exactly one row, found ${rows.length}.`);
      }
      return rows[0];
    },
    raw: () => rows.map((row) => Object.values(row))[Symbol.iterator](),
    next: (() => {
      let index = 0;
      return () => (index < rows.length ? { done: false, value: rows[index++] } : { done: true, value: undefined });
    })(),
    [Symbol.iterator]: () => rows[Symbol.iterator](),
    columnNames: rows[0] ? Object.keys(rows[0]) : [],
    rowsRead: rows.length,
    rowsWritten: written,
  };
}

/** What the Agents SDK keeps in Durable Object key-value storage: schema versions and facet names. */
type StoredValue = string | number | boolean | null | StoredValue[];

/** `ctx.storage` over SQLite: `sql.exec` runs each statement, and the key-value API lives in a Map. */
function durableObjectStorage() {
  const database = new sqlite.DatabaseSync(':memory:');
  const values = new Map<string, StoredValue>();
  let alarm: number | null = null;
  const storage = {
    sql: {
      exec(query: string, ...bindings: SQLInputValue[]) {
        const statements = query
          .split(/;\s*(?=\S)/)
          .map((statement) => statement.trim())
          .filter(Boolean);
        if (statements.length > 1 && bindings.length === 0) {
          database.exec(query);
          return cursor([], 0);
        }
        const statement = database.prepare(query);
        if (statement.columns().length > 0) {
          return cursor(statement.all(...bindings), 0);
        }
        return cursor([], Number(statement.run(...bindings).changes));
      },
      get databaseSize() {
        return 0;
      },
    },
    kv: {
      get: (key: string) => values.get(key),
      put: (key: string, value: StoredValue) => void values.set(key, value),
      delete: (key: string) => values.delete(key),
      list: () => values.entries(),
    },
    get: async (key: string) => values.get(key),
    put: async (key: string, value: StoredValue) => void values.set(key, value),
    delete: async (key: string) => values.delete(key),
    list: async () => new Map(values),
    transactionSync: <T>(operation: () => T): T => operation(),
    getAlarm: async () => alarm,
    setAlarm: async (at: number | Date) => {
      alarm = Number(at);
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    sync: async () => undefined,
  };
  return storage;
}

function durableObjectState(name: string) {
  const pending: Promise<unknown>[] = [];
  return {
    storage: durableObjectStorage(),
    id: { toString: () => `id-${name}`, name, equals: () => false },
    blockConcurrencyWhile: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
    getWebSockets: () => [],
    getTags: () => [],
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise.catch(() => undefined)),
    acceptWebSocket: () => undefined,
    setWebSocketAutoResponse: () => undefined,
    abort: () => undefined,
    pending,
  };
}

const READY_WORKSPACE: BuilderWorkspaceState = {
  initialized: true,
  revision: 3,
  resetRevision: 0,
  fileCount: 1,
  totalBytes: 10,
  seeding: false,
};

export const VALIDATED_CHECKPOINT: BuilderWorkspaceCheckpoint = { workspaceRevision: 3, revision: 'rev-3' };

/** A ready, validated, unlinked ProjectWorkspace; each test overrides what its path reads. */
function fakeWorkspace(overrides: Partial<BuilderWorkspaceApi> = {}): Partial<BuilderWorkspaceApi> {
  return {
    refresh: async () => READY_WORKSPACE,
    getState: () => READY_WORKSPACE,
    warmContainer: async () => undefined,
    linkedProject: async () => null,
    checkpoint: async () => VALIDATED_CHECKPOINT,
    hasSuccessfulValidation: async () => true,
    ...overrides,
  };
}

export type BuilderAgentHarness = Awaited<ReturnType<typeof builderAgentHarness>>;

/**
 * A started BuilderAgent for `OWNER_ID`'s chat, bound to its transcript in the runtime's D1.
 * @param options.ai the Workers AI binding a turn would use (`env.AI`)
 */
export async function builderAgentHarness(
  options: { workspace?: Partial<BuilderWorkspaceApi>; ai?: Partial<Ai>; cloudflareIdentity?: boolean } = {},
) {
  const { database, db } = userWorkspaceDatabase();
  database.exec(`
    INSERT INTO chats (id, creator_id, initial_id, description, timestamp)
      VALUES ('chat-1', '${OWNER_ID}', '${CHAT_INITIAL_ID}', 'A chat', '2026-10-20T00:00:00.000Z');
    INSERT INTO chat_transcripts (chat_id, subchat_index, generation, agent_name, transition_token, created_at, updated_at)
      VALUES ('chat-1', 0, 0, '${AGENT_NAME}', 'token-1', 1, 1);
  `);
  const ctx = durableObjectState(AGENT_NAME);
  const runtimeBindings: UserRuntimeBindings = { CLOUDCHEF_USER_RUNTIME: '1', AI: options.ai };
  if (options.cloudflareIdentity) {
    Object.assign(runtimeBindings, RUNTIME_IDENTITY);
  }
  const env = envWith({
    DB: db,
    CLOUDCHEF_RUNTIME_VERSION: RUNTIME_VERSION,
    // SAFETY: the user runtime's own bindings (`app/user-runtime-env.d.ts`) are not on the control
    // plane's Env; the agent reads them through the same guarded casts.
    ...(runtimeBindings as Partial<Env>),
  });
  // SAFETY: the agent and the Agents SDK read only the members `durableObjectState` implements.
  const agent = new BuilderAgent(ctx as never, env);
  // SAFETY: the ProjectWorkspace is the agent's one collaborator outside this process. It is replaced
  // before any call reaches it, with a fake of every member the exercised path calls.
  Reflect.set(agent, 'workspace', fakeWorkspace(options.workspace));
  await agent.onStart({ ownerId: OWNER_ID, userId: OWNER_ID });
  // The agent's own table: a proposal filed here is the one the Cloudflare request tool files mid-turn.
  // SAFETY: the repository uses only `sql.exec` and `transactionSync`, which the fake storage implements.
  const executions = new BuilderCloudflareExecutionRepository(ctx.storage as never);
  return {
    agent,
    database,
    ctx,
    /** Each agent's recorded activity, as the control plane's upgrade window reads it. */
    activity: () =>
      // SAFETY: the statement selects exactly these two columns of runtime_activity.
      database.prepare('SELECT agent_name, busy FROM runtime_activity ORDER BY agent_name').all() as Array<{
        agent_name: string;
        busy: number;
      }>,
    /** An upgrade to another Worker version found the runtime idle and is about to redeploy it. */
    openUpgradeWindow: (targetVersion = 'runtime-next', expiresAt = Date.now() + 60_000) =>
      database
        .prepare('INSERT OR REPLACE INTO runtime_upgrade_window (id, target_version, expires_at) VALUES (1, ?, ?)')
        .run(targetVersion, expiresAt),
    /** The redeploy happened (or the window lapsed): work waiting on it continues. */
    closeUpgradeWindow: () => database.prepare('DELETE FROM runtime_upgrade_window').run(),
    /** A Cloudflare write the model proposed in this transcript, awaiting the person's approval. */
    proposeCloudflareRequest: () => {
      const binding: CloudflareExecutionBinding = {
        userId: OWNER_ID,
        accountId: ACCOUNT_ID,
        connectionId: RUNTIME_IDENTITY.CLOUDCHEF_CONNECTION_ID,
        connectionGeneration: 1,
        oauthScopeGrantStatus: 'full',
        transcript: {
          agentName: AGENT_NAME,
          chatInitialId: CHAT_INITIAL_ID,
          generation: 0,
          subchatIndex: 0,
          parentAgentName: null,
        },
      };
      return executions.createProposal({
        toolCallId: 'tool-call-1',
        binding,
        request: {
          method: 'DELETE',
          url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/old`,
        },
      });
    },
    cloudflareExecution: (executionId: string) => executions.get(executionId),
  };
}

/** Resolve once `condition` holds, polling briefly; the agent's activity writes are asynchronous. */
export async function eventually(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('The condition did not hold in time.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Let pending microtasks and short timers run, to show that something did not happen. */
export function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
