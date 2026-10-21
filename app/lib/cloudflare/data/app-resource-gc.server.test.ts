import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { buildDeploymentPlanFromSource } from '~/lib/.server/cloudflare/deployment-plan';
import { userWorkspaceDatabase } from '~/test/control-plane-d1';
import { AGENT_GC_RETRY_BASE_MS } from './agent-gc.server';
import { sweepAppResourceGcCandidates } from './app-resource-gc.server';

describe('app resource garbage collection', () => {
  it('removes every resource derived from every deployment before completing the receipt', async () => {
    const workspace = new AppResourceGcWorkspace();
    workspace.deployment('deployment-1', JSON.stringify(await deploymentPlan()));
    const accountApi = cleanupApi(true);

    await expect(sweepAppResourceGcCandidates(workspace.env, { now: 100, accountApi })).resolves.toBeUndefined();

    expect(accountApi.deleteManagedWorker).toHaveBeenCalledWith('cloudchef-deployment-1');
    expect(accountApi.deleteD1Database).toHaveBeenCalledTimes(4);
    expect(accountApi.deleteKvNamespace).toHaveBeenCalledWith('cloudchef-deployment-1-cache');
    expect(accountApi.deleteR2Bucket).toHaveBeenCalledWith('cloudchef-deployment-1-storage');
    expect(workspace.candidates()).toEqual([]);
    expect(workspace.deploymentIds()).toEqual([]);
  });

  it('retains the receipt without increasing failures while R2 cleanup makes bounded progress', async () => {
    const workspace = new AppResourceGcWorkspace();
    workspace.deployment('deployment-1', JSON.stringify(await deploymentPlan()));
    const accountApi = cleanupApi(false);

    await expect(sweepAppResourceGcCandidates(workspace.env, { now: 1_000, accountApi })).resolves.toBeUndefined();

    expect(workspace.candidates()).toEqual([
      { chat_id: 'chat-row', not_before: 1_000 + AGENT_GC_RETRY_BASE_MS, attempts: 0 },
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

    await expect(sweepAppResourceGcCandidates(workspace.env, { now: 100, accountApi })).resolves.toBeUndefined();

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
      { chat_id: 'chat-row', not_before: 100 + AGENT_GC_RETRY_BASE_MS, attempts: 0 },
    ]);
  });

  it('deletes the Worker the plan names when an upload landed but was never recorded', async () => {
    const workspace = new AppResourceGcWorkspace();
    workspace.deployment('deployment-1', JSON.stringify(await deploymentPlan()), [['d1', 'DB', 'db-id-1']]);
    const accountApi = cleanupApi(true);

    await expect(sweepAppResourceGcCandidates(workspace.env, { now: 100, accountApi })).resolves.toBeUndefined();

    expect(accountApi.deleteManagedWorker).toHaveBeenCalledWith('cloudchef-deployment-1');
    expect(accountApi.deleteManagedWorker.mock.invocationCallOrder[0]).toBeLessThan(
      accountApi.deleteD1DatabaseById.mock.invocationCallOrder[0]!,
    );
    expect(accountApi.deleteD1Database).not.toHaveBeenCalled();
    expect(workspace.candidates()).toEqual([]);
  });

  it('releases a bounded number of deployments per sweep and resumes after them', async () => {
    const workspace = new AppResourceGcWorkspace();
    const plan = JSON.stringify(await deploymentPlan());
    for (let index = 1; index <= 8; index += 1) {
      workspace.deployment(`deployment-${index}`, plan);
    }
    const accountApi = cleanupApi(true);

    await sweepAppResourceGcCandidates(workspace.env, { now: 100, accountApi });

    // The resources every deployment names alike are deleted once a sweep, not once a deployment.
    expect(accountApi.deleteManagedWorker).toHaveBeenCalledTimes(1);
    expect(accountApi.deleteR2Bucket).toHaveBeenCalledTimes(1);
    expect(workspace.deploymentIds()).toEqual(['deployment-7', 'deployment-8']);
    expect(workspace.candidates()).toEqual([
      { chat_id: 'chat-row', not_before: 100 + AGENT_GC_RETRY_BASE_MS, attempts: 0 },
    ]);

    await sweepAppResourceGcCandidates(workspace.env, { now: 100 + AGENT_GC_RETRY_BASE_MS, accountApi });

    expect(accountApi.deleteManagedWorker).toHaveBeenCalledTimes(2);
    expect(workspace.deploymentIds()).toEqual([]);
    expect(workspace.candidates()).toEqual([]);
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

    await sweepAppResourceGcCandidates(workspace.env, { now: 1_000, accountApi });

    expect(workspace.deploymentIds()).toEqual(['deployment-2']);
    expect(workspace.candidates()).toEqual([
      { chat_id: 'chat-row', not_before: 1_000 + AGENT_GC_RETRY_BASE_MS, attempts: 1 },
    ]);
  });

  it('preserves the receipt when a stored plan uses a newer schema, and cleans up the others', async () => {
    const plan = await deploymentPlan();
    const workspace = new AppResourceGcWorkspace();
    workspace.deployment('deployment-1', JSON.stringify({ ...plan, version: 999 }));
    workspace.deployment('deployment-2', JSON.stringify(plan));
    const accountApi = cleanupApi(true);

    await expect(sweepAppResourceGcCandidates(workspace.env, { now: 100, accountApi })).resolves.toBeUndefined();

    expect(accountApi.deleteManagedWorker).toHaveBeenCalledTimes(1);
    expect(workspace.deploymentIds()).toEqual(['deployment-1']);
    expect(workspace.candidates()).toEqual([
      { chat_id: 'chat-row', not_before: 100 + AGENT_GC_RETRY_BASE_MS, attempts: 0 },
    ]);
  });

  it('backs off and preserves the receipt when Cloudflare cleanup fails', async () => {
    const workspace = new AppResourceGcWorkspace(2);
    workspace.deployment('deployment-1', JSON.stringify(await deploymentPlan()));
    const accountApi = cleanupApi(true);
    accountApi.deleteManagedWorker.mockRejectedValueOnce(new Error('temporary provider failure'));

    await expect(sweepAppResourceGcCandidates(workspace.env, { now: 1_000, accountApi })).resolves.toBeUndefined();

    expect(workspace.candidates()).toEqual([
      { chat_id: 'chat-row', not_before: 1_000 + AGENT_GC_RETRY_BASE_MS * 4, attempts: 3 },
    ]);
    expect(workspace.deploymentIds()).toEqual(['deployment-1']);
  });
});

async function deploymentPlan() {
  return (
    await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: 'a'.repeat(64),
      project: {
        type: 'web_app',
        bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true },
      },
    })
  ).plan;
}

function cleanupApi(r2Complete: boolean) {
  return {
    deleteManagedWorker: vi.fn(async (_name: string) => undefined),
    deleteD1Database: vi.fn(async (_name: string) => undefined),
    deleteKvNamespace: vi.fn(async (_name: string) => undefined),
    deleteD1DatabaseById: vi.fn(async (_id: string) => undefined),
    deleteKvNamespaceById: vi.fn(async (_id: string) => undefined),
    deleteR2Bucket: vi.fn(async (_name: string) => r2Complete),
  };
}

/** A workspace D1 holding one removed chat, its cleanup receipt, and the deployments a test adds. */
class AppResourceGcWorkspace {
  readonly #database: DatabaseSync;
  readonly env: Parameters<typeof sweepAppResourceGcCandidates>[0];
  #created = 0;

  constructor(attempts = 0) {
    const { database, db } = userWorkspaceDatabase();
    this.#database = database;
    // SAFETY: the sweep reads only `DB` once it is handed an account API.
    this.env = { DB: db } as Parameters<typeof sweepAppResourceGcCandidates>[0];
    database
      .prepare(
        `INSERT INTO chats (id, creator_id, initial_id, timestamp, is_deleted)
         VALUES ('chat-row', 'user-1', 'initial-1', '2026-10-01T00:00:00.000Z', 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO app_resource_gc_candidates (chat_id, not_before, created_at, attempts)
         VALUES ('chat-row', 50, 0, ?)`,
      )
      .run(attempts);
  }

  deployment(id: string, planJson: string, resources: [type: string, logicalName: string, providerId: string][] = []) {
    this.#created += 1;
    this.#database
      .prepare(
        `INSERT INTO deployments (
           id, chat_id, user_id, connection_id, connection_generation, workspace_reference,
           status, plan_json, plan_digest, created_at, updated_at
         ) VALUES (?, 'chat-row', 'user-1', 'connection-1', 1, 'workspace-runtime:project:1:hash',
           'succeeded', ?, 'digest', ?, ?)`,
      )
      .run(id, planJson, this.#created, this.#created);
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
      .prepare('SELECT chat_id, not_before, attempts FROM app_resource_gc_candidates ORDER BY chat_id')
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
}
