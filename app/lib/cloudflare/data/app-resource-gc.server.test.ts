import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDeploymentPlanFromSource, type DeploymentResourceNaming } from '~/lib/.server/cloudflare/deployment-plan';
import { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import { userWorkspaceDatabase } from '~/test/control-plane-d1';
import { fakeArtifacts } from '~/test/fake-artifacts';
import { AGENT_GC_GRACE_PERIOD_MS, AGENT_GC_RETRY_BASE_MS } from './agent-gc.server';
import { sweepAppResourceGcCandidates } from './app-resource-gc.server';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // The control plane's credential broker, which the sweep asks for the account's token.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ accessToken: 'user-oauth-token' }, { headers: { 'Cache-Control': 'no-store' } })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Sweeps with the clock at `now`. */
function sweepAt(now: number, env: AppResourceGcWorkspace['env'], options?: { requeueRemovedChats: boolean }) {
  vi.setSystemTime(now);
  return sweepAppResourceGcCandidates(env, options);
}

describe('app resource garbage collection', () => {
  it('removes every resource derived from every deployment before completing the receipt', async () => {
    const workspace = new AppResourceGcWorkspace();
    workspace.deployment('deployment-1', JSON.stringify(await deploymentPlan()));
    const accountApi = cleanupApi(true);

    await expect(sweepAt(100, workspace.env)).resolves.toBeUndefined();

    expect(accountApi.deleteManagedWorker.mock.calls).toEqual([['cloudchef-deployment-1']]);
    expect(accountApi.deleteD1Database).toHaveBeenCalledTimes(2);
    expect(accountApi.deleteKvNamespace.mock.calls).toEqual([['cloudchef-deployment-1-cache']]);
    expect(accountApi.deleteR2Bucket.mock.calls).toEqual([['cloudchef-deployment-1-storage']]);
    expect(workspace.candidates()).toEqual([]);
    expect(workspace.deploymentIds()).toEqual([]);
  });

  it("deletes a removed chat's own repository, which all its conversations share, with its clone tokens", async () => {
    const workspace = new AppResourceGcWorkspace();
    const artifacts = fakeArtifacts();
    for (const repo of ['p-initial-chat-row', 'p-other']) {
      await artifacts.create(repo);
    }
    workspace.cloneToken('p-initial-chat-row');
    cleanupApi(true);

    await sweepAt(100, { ...workspace.env, ARTIFACTS: artifacts });

    expect([...artifacts.repos.keys()]).toEqual(['p-other']);
    expect(workspace.cloneTokenRepos()).toEqual([]);
    expect(workspace.candidates()).toEqual([]);
  });

  it("keeps a team account's draft repositories, which can become the team's projects", async () => {
    const workspace = new AppResourceGcWorkspace();
    const artifacts = fakeArtifacts();
    await artifacts.create('p-initial-chat-row');
    cleanupApi(true);

    await sweepAt(100, { ...workspace.env, ARTIFACTS: artifacts, CLOUDCHEF_SHARED_ACCOUNT: '1' });

    expect([...artifacts.repos.keys()]).toEqual(['p-initial-chat-row']);
    expect(workspace.candidates()).toEqual([]);
  });

  it('retains the receipt without increasing failures while R2 cleanup makes bounded progress', async () => {
    const workspace = new AppResourceGcWorkspace();
    workspace.deployment('deployment-1', JSON.stringify(await deploymentPlan()));
    cleanupApi(false);

    await expect(sweepAt(1_000, workspace.env)).resolves.toBeUndefined();

    expect(workspace.candidates()).toEqual([
      { workspace_id: 'chat-row', not_before: 1_000 + AGENT_GC_RETRY_BASE_MS, attempts: 0 },
    ]);
    expect(workspace.deploymentIds()).toEqual(['deployment-1']);
  });

  it('deletes what provisioning recorded, by provider id, even when this build cannot read the plan', async () => {
    const workspace = new AppResourceGcWorkspace();
    workspace.deployment('deployment-1', JSON.stringify({ version: 999 }), [
      ['worker', 'app', 'cloudchef-app-1'],
      ['d1', 'DB', 'db-id-1'],
      ['kv', 'APP_CACHE', 'kv-id-1'],
      ['r2', 'APP_STORAGE', 'cloudchef-app-1-storage'],
    ]);
    const accountApi = cleanupApi(true);

    await expect(sweepAt(100, workspace.env)).resolves.toBeUndefined();

    expect(accountApi.deleteManagedWorker).toHaveBeenCalledWith('cloudchef-app-1');
    expect(accountApi.deleteD1DatabaseById).toHaveBeenCalledWith('db-id-1');
    expect(accountApi.deleteKvNamespaceById).toHaveBeenCalledWith('kv-id-1');
    expect(accountApi.deleteR2Bucket).toHaveBeenCalledWith('cloudchef-app-1-storage');
    expect(accountApi.deleteManagedWorker.mock.invocationCallOrder[0]).toBeLessThan(
      accountApi.deleteD1DatabaseById.mock.invocationCallOrder[0]!,
    );
    // What it recorded is gone, so a retry does not delete it again; the deployment itself waits for a
    // build that can read what its plan names.
    expect(workspace.resourceCount()).toBe(0);
    expect(workspace.deploymentIds()).toEqual(['deployment-1']);
    expect(workspace.candidates()).toEqual([
      { workspace_id: 'chat-row', not_before: 100 + AGENT_GC_RETRY_BASE_MS, attempts: 0 },
    ]);
  });

  it('deletes by name every plan resource a deployment has no record of, after the Worker', async () => {
    const workspace = new AppResourceGcWorkspace();
    workspace.deployment('deployment-1', JSON.stringify(await deploymentPlan()), [['d1', 'DB', 'db-id-1']]);
    const accountApi = cleanupApi(true);

    await expect(sweepAt(100, workspace.env)).resolves.toBeUndefined();

    expect(accountApi.deleteManagedWorker).toHaveBeenCalledWith('cloudchef-deployment-1');
    expect(accountApi.deleteManagedWorker.mock.invocationCallOrder[0]).toBeLessThan(
      accountApi.deleteD1DatabaseById.mock.invocationCallOrder[0]!,
    );
    expect(accountApi.deleteD1DatabaseById).toHaveBeenCalledWith('db-id-1');
    // The recorded database is deleted by its id, and the others (a second database, the bucket and the
    // namespace whose records never landed) by the names the plan gives them.
    expect(accountApi.deleteD1Database.mock.calls.map(([name]) => name)).toEqual([
      'cloudchef-deployment-1-agent-security',
    ]);
    expect(accountApi.deleteR2Bucket).toHaveBeenCalledWith('cloudchef-deployment-1-storage');
    expect(accountApi.deleteKvNamespace).toHaveBeenCalledWith('cloudchef-deployment-1-cache');
    expect(workspace.candidates()).toEqual([]);
  });

  it('releases a bounded number of deployments per sweep and resumes after them', async () => {
    const workspace = new AppResourceGcWorkspace();
    const plan = JSON.stringify(await deploymentPlan());
    for (let index = 1; index <= 8; index += 1) {
      workspace.deployment(`deployment-${index}`, plan);
    }
    const accountApi = cleanupApi(true);

    await sweepAt(100, workspace.env);

    // The resources every deployment names alike stay while a later deployment names them.
    expect(accountApi.deleteManagedWorker).not.toHaveBeenCalled();
    expect(accountApi.deleteR2Bucket).not.toHaveBeenCalled();
    expect(workspace.deploymentIds()).toEqual(['deployment-7', 'deployment-8']);
    expect(workspace.candidates()).toEqual([
      { workspace_id: 'chat-row', not_before: 100 + AGENT_GC_RETRY_BASE_MS, attempts: 0 },
    ]);

    await sweepAt(100 + AGENT_GC_RETRY_BASE_MS, workspace.env);

    // The last deployment deletes them, once.
    expect(accountApi.deleteManagedWorker.mock.calls).toEqual([['cloudchef-deployment-1']]);
    expect(accountApi.deleteD1Database).toHaveBeenCalledTimes(2);
    expect(accountApi.deleteR2Bucket).toHaveBeenCalledTimes(1);
    expect(accountApi.deleteKvNamespace).toHaveBeenCalledTimes(1);
    expect(workspace.deploymentIds()).toEqual([]);
    expect(workspace.candidates()).toEqual([]);
  });

  it('leaves a Worker it recorded, under a plan it cannot read, to the later deployment naming it', async () => {
    const workspace = new AppResourceGcWorkspace();
    const plan = await deploymentPlan();
    workspace.deployment('deployment-1', JSON.stringify({ version: 999 }), [
      ['worker', 'app', 'cloudchef-deployment-1'],
    ]);
    workspace.deployment('deployment-2', JSON.stringify(plan));
    const accountApi = cleanupApi(true);

    await sweepAt(100, workspace.env);

    // Released by the second deployment only, by the name its plan gives it.
    expect(accountApi.deleteManagedWorker.mock.calls).toEqual([['cloudchef-deployment-1']]);
    expect(workspace.deploymentIds()).toEqual(['deployment-1']);
  });

  it('leaves a resource to a later deployment that only records it', async () => {
    const workspace = new AppResourceGcWorkspace();
    workspace.deployment('deployment-1', JSON.stringify(await deploymentPlan()), [['kv', 'APP_CACHE', 'kv-id-1']]);
    // A plan this build cannot read, so only its record says it uses the namespace.
    workspace.deployment('deployment-2', JSON.stringify({ version: 999 }), [['kv', 'APP_CACHE', 'kv-id-1']]);
    const accountApi = cleanupApi(true);

    await sweepAt(100, workspace.env);

    // Deleted once, by the later deployment's record.
    expect(accountApi.deleteKvNamespaceById.mock.calls).toEqual([['kv-id-1']]);
    expect(workspace.deploymentIds()).toEqual(['deployment-2']);
  });

  it('keeps a failed sweep’s released deployments released', async () => {
    const workspace = new AppResourceGcWorkspace();
    const plan = JSON.stringify(await deploymentPlan());
    workspace.deployment('deployment-1', plan, [['worker', 'app', 'cloudchef-app-1']]);
    workspace.deployment('deployment-2', plan, [['worker', 'app', 'cloudchef-app-2']]);
    const accountApi = cleanupApi(true);
    accountApi.deleteManagedWorker.mockImplementation(async (name: string) => {
      if (name === 'cloudchef-app-2') {
        throw new Error('temporary provider failure');
      }
    });

    await sweepAt(1_000, workspace.env);

    expect(workspace.deploymentIds()).toEqual(['deployment-2']);
    expect(workspace.candidates()).toEqual([
      { workspace_id: 'chat-row', not_before: 1_000 + AGENT_GC_RETRY_BASE_MS, attempts: 1 },
    ]);
  });

  it('preserves the receipt when a stored plan uses a newer schema, and cleans up the others', async () => {
    const plan = await deploymentPlan();
    const workspace = new AppResourceGcWorkspace();
    workspace.deployment('deployment-1', JSON.stringify({ ...plan, version: 999 }));
    workspace.deployment('deployment-2', JSON.stringify(plan));
    const accountApi = cleanupApi(true);

    await expect(sweepAt(100, workspace.env)).resolves.toBeUndefined();

    expect(accountApi.deleteManagedWorker).toHaveBeenCalledOnce();
    expect(workspace.deploymentIds()).toEqual(['deployment-1']);
    expect(workspace.candidates()).toEqual([
      { workspace_id: 'chat-row', not_before: 100 + AGENT_GC_RETRY_BASE_MS, attempts: 0 },
    ]);
  });

  it('queues, from the scheduled sweep only, removed chats whose deployment records outlived their candidate, and releases them after the grace period', async () => {
    const workspace = new AppResourceGcWorkspace(0, { queued: false });
    const plan = JSON.stringify(await deploymentPlan());
    workspace.deployment('deployment-1', plan, [['d1', 'DB', 'db-id-1']]);
    // A project still in use, and a removed one with nothing left to release, are never queued.
    workspace.chat('chat-active', { removed: false });
    workspace.deployment('deployment-active', plan, [], 'chat-active');
    workspace.chat('chat-empty', { removed: true });
    const accountApi = cleanupApi(true);

    // A request's sweep adds no write.
    await sweepAt(1_000, workspace.env);
    expect(workspace.candidates()).toEqual([]);

    await sweepAt(1_000, workspace.env, { requeueRemovedChats: true });
    expect(workspace.candidates()).toEqual([
      { workspace_id: 'chat-row', not_before: 1_000 + AGENT_GC_GRACE_PERIOD_MS, attempts: 0 },
    ]);
    expect(accountApi.deleteManagedWorker).not.toHaveBeenCalled();

    await sweepAt(1_000 + AGENT_GC_GRACE_PERIOD_MS, workspace.env, { requeueRemovedChats: true });

    // What is left is deleted, by id where it was recorded and by name otherwise; a name already gone is
    // the account API's to skip.
    expect(accountApi.deleteManagedWorker).toHaveBeenCalledWith('cloudchef-deployment-1');
    expect(accountApi.deleteD1DatabaseById).toHaveBeenCalledWith('db-id-1');
    expect(workspace.deploymentIds()).toEqual(['deployment-active']);
    expect(workspace.activityDeploymentIds()).toEqual(['deployment-active']);
    expect(workspace.resourceCount()).toBe(0);
    expect(workspace.candidates()).toEqual([]);
  });

  it('queues a bounded number of removed chats per scheduled sweep', async () => {
    const workspace = new AppResourceGcWorkspace(0, { queued: false });
    const plan = JSON.stringify(await deploymentPlan());
    for (let index = 0; index < 25; index += 1) {
      const chatId = `chat-${String(index).padStart(2, '0')}`;
      workspace.chat(chatId, { removed: true });
      workspace.deployment(`deployment-${chatId}`, plan, [], chatId);
    }
    cleanupApi(true);

    await sweepAt(1_000, workspace.env, { requeueRemovedChats: true });
    expect(workspace.candidates()).toHaveLength(20);

    await sweepAt(1_000, workspace.env, { requeueRemovedChats: true });
    // The rest, without queueing any twice; `chat-row` has no deployment records, so it is never queued.
    expect(workspace.candidates().map(({ workspace_id }) => workspace_id)).toEqual(
      Array.from({ length: 25 }, (_, index) => `chat-${String(index).padStart(2, '0')}`),
    );
  });

  it('backs off and preserves the receipt when Cloudflare cleanup fails', async () => {
    const workspace = new AppResourceGcWorkspace(2);
    workspace.deployment('deployment-1', JSON.stringify(await deploymentPlan()));
    const accountApi = cleanupApi(true);
    accountApi.deleteManagedWorker.mockRejectedValueOnce(new Error('temporary provider failure'));

    await expect(sweepAt(1_000, workspace.env)).resolves.toBeUndefined();

    expect(workspace.candidates()).toEqual([
      { workspace_id: 'chat-row', not_before: 1_000 + AGENT_GC_RETRY_BASE_MS * 4, attempts: 3 },
    ]);
    expect(workspace.deploymentIds()).toEqual(['deployment-1']);
  });
});

async function deploymentPlan(naming: DeploymentResourceNaming = { identity: 'deployment-1' }) {
  return (
    await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: 'a'.repeat(64),
      naming,
      project: {
        type: 'web_app',
        bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true },
      },
    })
  ).plan;
}

/** The account API's deletions, answered without Cloudflare; R2 reports whether the bucket is gone. */
function cleanupApi(r2Complete: boolean) {
  const api = UserCloudflareAccountApi.prototype;
  return {
    deleteManagedWorker: vi.spyOn(api, 'deleteManagedWorker').mockResolvedValue(undefined),
    deleteD1Database: vi.spyOn(api, 'deleteD1Database').mockResolvedValue(undefined),
    deleteKvNamespace: vi.spyOn(api, 'deleteKvNamespace').mockResolvedValue(undefined),
    deleteD1DatabaseById: vi.spyOn(api, 'deleteD1DatabaseById').mockResolvedValue(undefined),
    deleteKvNamespaceById: vi.spyOn(api, 'deleteKvNamespaceById').mockResolvedValue(undefined),
    deleteR2Bucket: vi.spyOn(api, 'deleteR2Bucket').mockResolvedValue(r2Complete),
  };
}

/** A workspace D1 holding one removed chat, its cleanup receipt, and the deployments a test adds. */
class AppResourceGcWorkspace {
  readonly #database: DatabaseSync;
  readonly env: Parameters<typeof sweepAppResourceGcCandidates>[0];
  #created = 0;

  /** `queued: false` leaves the removed chat without a candidate, as an older collector did. */
  constructor(attempts = 0, { queued = true }: { queued?: boolean } = {}) {
    const { database, db } = userWorkspaceDatabase();
    this.#database = database;
    this.env = {
      DB: db,
      CLOUDCHEF_USER_RUNTIME: '1',
      CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://cloudchef.build',
      CONTROL_PLANE_SECRET: 'runtime-secret-that-is-long-enough',
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      CLOUDCHEF_USER_ID: 'user-1',
      CLOUDCHEF_CONNECTION_ID: 'connection-1',
      CLOUDCHEF_CONNECTION_GENERATION: '3',
    };
    this.chat('chat-row', { removed: true });
    if (queued) {
      database
        .prepare(
          `INSERT INTO app_resource_gc_candidates (workspace_id, not_before, created_at, attempts)
           VALUES ('chat-row', 50, 0, ?)`,
        )
        .run(attempts);
    }
  }

  cloneToken(repo: string) {
    this.#database
      .prepare(
        `INSERT INTO clone_tokens (repo, user_id, token_id, secret, remote, expires_at)
         VALUES (?, 'user-1', 'token-1', 'secret', 'https://example.com/r.git', 9999999999999)`,
      )
      .run(repo);
  }

  cloneTokenRepos() {
    return this.#database.prepare('SELECT repo FROM clone_tokens').all();
  }

  chat(id: string, { removed }: { removed: boolean }) {
    this.#database
      .prepare(
        `INSERT INTO workspaces (id, creator_id, initial_id, timestamp, is_deleted)
         VALUES (?, 'user-1', ?, '2026-10-01T00:00:00.000Z', ?)`,
      )
      .run(id, `initial-${id}`, removed ? 1 : 0);
  }

  deployment(
    id: string,
    planJson: string,
    resources: [type: string, logicalName: string, providerId: string][] = [],
    chatId = 'chat-row',
  ) {
    this.#created += 1;
    this.#database
      .prepare(
        `INSERT INTO deployments (
           id, workspace_id, user_id, connection_id, connection_generation, workspace_reference,
           status, plan_json, plan_digest, created_at, updated_at
         ) VALUES (?, ?, 'user-1', 'connection-1', 1, 'workspace-runtime:project:1:hash',
           'succeeded', ?, 'digest', ?, ?)`,
      )
      .run(id, chatId, planJson, this.#created, this.#created);
    this.#database
      .prepare(
        `INSERT INTO deployment_activity (deployment_id, execution_generation, sequence, message, created_at)
         VALUES (?, 1, 1, 'Deployed', 0)`,
      )
      .run(id);
    for (const [type, logicalName, providerId] of resources) {
      this.#database
        .prepare(
          `INSERT INTO deployment_resources (id, deployment_id, resource_type, logical_name, provider_resource_id, created_at)
           VALUES (?, ?, ?, ?, ?, 0)`,
        )
        .run(`${id}:${type}:${logicalName}`, id, type, logicalName, providerId);
    }
  }

  candidates() {
    return this.#database
      .prepare('SELECT workspace_id, not_before, attempts FROM app_resource_gc_candidates ORDER BY workspace_id')
      .all()
      .map((row) => ({ ...row }));
  }

  deploymentIds() {
    return this.#database
      .prepare('SELECT id FROM deployments ORDER BY created_at')
      .all()
      .map((row) => row.id);
  }

  resourceCount() {
    return this.#database.prepare('SELECT COUNT(*) AS count FROM deployment_resources').get()?.count;
  }

  activityDeploymentIds() {
    return this.#database
      .prepare('SELECT deployment_id FROM deployment_activity ORDER BY deployment_id')
      .all()
      .map((row) => row.deployment_id);
  }
}
