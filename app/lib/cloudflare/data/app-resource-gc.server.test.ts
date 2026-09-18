import { describe, expect, it, vi } from 'vitest';
import { buildDeploymentPlanFromSource } from '~/lib/.server/cloudflare/deployment-plan';
import { AGENT_GC_GRACE_PERIOD_MS, AGENT_GC_RETRY_BASE_MS } from './agent-gc.server';
import { prepareAppResourceGcCandidateStatement, sweepAppResourceGcCandidates } from './app-resource-gc.server';

describe('app resource garbage collection receipts', () => {
  it('queues provider cleanup with the project deletion grace period', () => {
    const bind = vi.fn(() => ({}) as D1PreparedStatement);
    const db = { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database;

    prepareAppResourceGcCandidateStatement(db, {
      initialId: 'chat',
      ownerId: 'owner',
      now: 1_000,
    });

    expect(bind).toHaveBeenCalledWith(1_000 + AGENT_GC_GRACE_PERIOD_MS, 1_000, 'chat', 'owner');
  });

  it('uses the durable-empty predicate when an empty chat is discarded', () => {
    const bind = vi.fn(() => ({}) as D1PreparedStatement);
    const prepare = vi.fn(() => ({ bind }));

    prepareAppResourceGcCandidateStatement({ prepare } as unknown as D1Database, {
      initialId: 'chat',
      ownerId: 'owner',
      requireEmpty: true,
    });

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('chats.has_messages = 0'));
  });
});

describe('app resource garbage collection', () => {
  it('removes every resource derived from every deployment before completing the receipt', async () => {
    const plan = await deploymentPlan();
    const database = new AppResourceGcDatabase([JSON.stringify(plan)]);
    const accountApi = cleanupApi(true);

    await expect(sweepAppResourceGcCandidates(database.env, { now: 100, accountApi })).resolves.toBeUndefined();

    expect(accountApi.deleteManagedWorker).toHaveBeenCalledWith('ghostbuild-deployment-1');
    expect(accountApi.deleteD1Database).toHaveBeenCalledTimes(4);
    expect(accountApi.deleteKvNamespace).toHaveBeenCalledWith('ghostbuild-deployment-1-cache');
    expect(accountApi.deleteR2Bucket).toHaveBeenCalledWith('ghostbuild-deployment-1-storage');
    expect(database.candidates).toEqual([]);
  });

  it('retains the receipt without increasing failures while R2 cleanup makes bounded progress', async () => {
    const database = new AppResourceGcDatabase([JSON.stringify(await deploymentPlan())]);
    const accountApi = cleanupApi(false);

    await expect(sweepAppResourceGcCandidates(database.env, { now: 1_000, accountApi })).resolves.toBeUndefined();

    expect(database.candidates).toEqual([
      { chat_id: 'chat-row', not_before: 1_000 + AGENT_GC_RETRY_BASE_MS, attempts: 0 },
    ]);
  });

  it('deletes what provisioning recorded, by provider id, without reading the plan', async () => {
    const database = new AppResourceGcDatabase([JSON.stringify({ version: 999 })], 0, [
      { deployment_id: 'deployment-1', resource_type: 'worker', provider_resource_id: 'ghostbuild-app-1' },
      { deployment_id: 'deployment-1', resource_type: 'd1', provider_resource_id: 'db-id-1' },
      { deployment_id: 'deployment-1', resource_type: 'kv', provider_resource_id: 'kv-id-1' },
      { deployment_id: 'deployment-1', resource_type: 'r2', provider_resource_id: 'ghostbuild-app-1-storage' },
    ]);
    const accountApi = cleanupApi(true);

    await expect(sweepAppResourceGcCandidates(database.env, { now: 100, accountApi })).resolves.toBeUndefined();

    expect(accountApi.deleteManagedWorker).toHaveBeenCalledWith('ghostbuild-app-1');
    expect(accountApi.deleteD1DatabaseById).toHaveBeenCalledWith('db-id-1');
    expect(accountApi.deleteKvNamespaceById).toHaveBeenCalledWith('kv-id-1');
    expect(accountApi.deleteR2Bucket).toHaveBeenCalledWith('ghostbuild-app-1-storage');
    expect(accountApi.deleteManagedWorker.mock.invocationCallOrder[0]).toBeLessThan(
      accountApi.deleteD1DatabaseById.mock.invocationCallOrder[0]!,
    );
    expect(database.candidates).toEqual([]);
  });

  it('retries the receipt while a recorded R2 bucket is still draining', async () => {
    const database = new AppResourceGcDatabase([JSON.stringify({ version: 999 })], 0, [
      { deployment_id: 'deployment-1', resource_type: 'r2', provider_resource_id: 'ghostbuild-app-1-storage' },
    ]);
    const accountApi = cleanupApi(false);

    await expect(sweepAppResourceGcCandidates(database.env, { now: 1_000, accountApi })).resolves.toBeUndefined();

    expect(database.candidates).toEqual([
      { chat_id: 'chat-row', not_before: 1_000 + AGENT_GC_RETRY_BASE_MS, attempts: 0 },
    ]);
  });

  it('preserves the receipt when a stored plan uses a newer schema', async () => {
    const plan = await deploymentPlan();
    const database = new AppResourceGcDatabase([JSON.stringify({ ...plan, version: 999 }), JSON.stringify(plan)]);
    const accountApi = cleanupApi(true);

    await expect(sweepAppResourceGcCandidates(database.env, { now: 100, accountApi })).resolves.toBeUndefined();

    expect(accountApi.deleteManagedWorker).not.toHaveBeenCalled();
    expect(database.candidates).toEqual([
      { chat_id: 'chat-row', not_before: 100 + AGENT_GC_RETRY_BASE_MS, attempts: 0 },
    ]);
  });

  it('backs off and preserves the receipt when Cloudflare cleanup fails', async () => {
    const database = new AppResourceGcDatabase([JSON.stringify(await deploymentPlan())], 2);
    const accountApi = cleanupApi(true);
    accountApi.deleteManagedWorker.mockRejectedValueOnce(new Error('temporary provider failure'));

    await expect(sweepAppResourceGcCandidates(database.env, { now: 1_000, accountApi })).resolves.toBeUndefined();

    expect(database.candidates).toEqual([
      { chat_id: 'chat-row', not_before: 1_000 + AGENT_GC_RETRY_BASE_MS * 4, attempts: 3 },
    ]);
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

type Candidate = { chat_id: string; not_before: number; attempts: number };

class AppResourceGcDatabase {
  readonly candidates: Candidate[];

  constructor(
    private readonly plans: string[],
    attempts = 0,
    private readonly resources: { deployment_id: string; resource_type: string; provider_resource_id: string }[] = [],
  ) {
    this.candidates = [{ chat_id: 'chat-row', not_before: 50, attempts }];
  }

  readonly env = {
    DB: {
      prepare: (query: string) => ({
        bind: (...values: unknown[]) => ({
          all: async () => this.all(query, values),
          run: async () => this.run(query, values),
        }),
      }),
    },
  } as unknown as Parameters<typeof sweepAppResourceGcCandidates>[0];

  private all(query: string, values: unknown[]) {
    if (query.includes('FROM app_resource_gc_candidates AS candidates')) {
      const [now, limit] = values as [number, number];
      return {
        results: this.candidates.filter((candidate) => candidate.not_before <= now).slice(0, limit),
      };
    }
    if (query.includes('FROM deployment_resources')) {
      return { results: this.resources };
    }
    if (query.includes('FROM deployments')) {
      return { results: this.plans.map((plan_json, index) => ({ id: `deployment-${index + 1}`, plan_json })) };
    }
    return { results: [] };
  }

  private run(query: string, values: unknown[]): D1Result {
    if (query.includes('DELETE FROM app_resource_gc_candidates')) {
      const [chatId, notBefore] = values as [string, number];
      const index = this.candidates.findIndex(
        (candidate) => candidate.chat_id === chatId && candidate.not_before === notBefore,
      );
      if (index < 0) {
        return changed(0);
      }
      this.candidates.splice(index, 1);
      return changed(1);
    }
    if (query.includes('UPDATE app_resource_gc_candidates')) {
      const [attempts, retryAt, chatId, notBefore] = values as [number, number, string, number];
      const candidate = this.candidates.find((item) => item.chat_id === chatId && item.not_before === notBefore);
      if (!candidate) {
        return changed(0);
      }
      Object.assign(candidate, { attempts, not_before: retryAt });
      return changed(1);
    }
    return changed(0);
  }
}

function changed(changes: number): D1Result {
  return { success: true, meta: { changes } } as D1Result;
}
