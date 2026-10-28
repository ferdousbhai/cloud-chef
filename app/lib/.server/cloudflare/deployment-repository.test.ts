import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimApprovedDeployment,
  createDeployment,
  DeploymentConcurrencyLimitError,
  DeploymentStateConflictError,
  findActiveProjectDeployment,
  latestDeploymentActivity,
  listDeploymentActivity,
  prepareDeploymentRetry,
  recordDeploymentActivity,
  requireDeployment,
  transitionDeployment,
  type Deployment,
} from './deployment-repository';
import { type DeploymentPlan } from './deployment-plan';

const sourceSha256 = 'a'.repeat(64);
const planDigest = 'b'.repeat(64);
const plan: DeploymentPlan = {
  version: 5,
  deploymentId: 'deployment-1',
  sourceSha256,
  project: { type: 'web_app', bindings: { ai: false, d1: false, r2: false, kv: false, appAgent: false } },
  resources: [{ type: 'worker', logicalName: 'app', proposedName: 'cloudchef-deployment-1' }],
};

let sqlite: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  // Only the clock is faked: the repository stamps its writes with Date.now().
  vi.useFakeTimers({ toFake: ['Date'] });
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync('user-workspace-migrations').sort()) {
    sqlite.exec(readFileSync(`user-workspace-migrations/${file}`, 'utf8'));
  }
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, creator_id, initial_id, timestamp) VALUES ('chat-1', 'user-1', 'initial-1', 'now')`,
    )
    .run();
  db = d1(sqlite);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deployment repository', () => {
  it('stores unlimited lightweight workspace references without artifact state', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await create(index);
    }

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM deployments').get()).toEqual({ count: 4 });
    expect(
      sqlite
        .prepare('PRAGMA table_info(deployments)')
        .all()
        .map((column) => column.name),
    ).not.toEqual(expect.arrayContaining(['snapshot_key', 'build_artifact_key', 'build_artifact_generation']));
  });

  it('rejects malformed persisted deployment plans at the repository boundary', async () => {
    await create(1);
    const { project: _project, ...missingProject } = plan;
    sqlite
      .prepare(`UPDATE deployments SET plan_json = ? WHERE id = 'deployment-1'`)
      .run(JSON.stringify(missingProject));

    await expect(requireDeployment(db, 'deployment-1', 'user-1')).rejects.toThrow();
  });

  it('claims and completes the exact connection-bound execution', async () => {
    const approved = await create(1);
    expect(approved).toMatchObject({ status: 'approved', executionGeneration: 1 });

    vi.setSystemTime(30);
    const claimed = await claimApprovedDeployment({
      db,
      deploymentId: approved.id,
      userId: approved.userId,
      connectionId: approved.connectionId,
      connectionGeneration: approved.connectionGeneration,
      executionGeneration: approved.executionGeneration,
    });
    expect(claimed.status).toBe('provisioning');

    await transitionDeployment({
      db,
      deploymentId: claimed.id,
      executionGeneration: claimed.executionGeneration,
      expectedStatus: 'provisioning',
      nextStatus: 'deploying',
      now: 40,
    });
    await transitionDeployment({
      db,
      deploymentId: claimed.id,
      executionGeneration: claimed.executionGeneration,
      expectedStatus: 'deploying',
      nextStatus: 'succeeded',
      productionUrl: 'https://app.example.workers.dev',
      now: 50,
    });

    await expect(requireDeployment(db, claimed.id, claimed.userId)).resolves.toMatchObject({
      status: 'succeeded',
      productionUrl: 'https://app.example.workers.dev',
    });
  });

  it('records ordered activity independently for each retry generation', async () => {
    const approved = await approvedDeployment(1);
    vi.setSystemTime(22);
    await recordDeploymentActivity({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration,
      sequence: 20,
      message: 'Cloudflare is ready',
    });
    vi.setSystemTime(21);
    await recordDeploymentActivity({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration,
      sequence: 10,
      message: 'Getting Cloudflare ready',
    });

    await expect(listDeploymentActivity(db, approved.id, approved.executionGeneration)).resolves.toEqual([
      { sequence: 10, message: 'Getting Cloudflare ready', createdAt: 21 },
      { sequence: 20, message: 'Cloudflare is ready', createdAt: 22 },
    ]);
    await expect(listDeploymentActivity(db, approved.id, approved.executionGeneration + 1)).resolves.toEqual([]);
  });

  it('reads back the step the current execution recorded most recently', async () => {
    const approved = await approvedDeployment(1);
    vi.setSystemTime(21);
    await recordDeploymentActivity({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration,
      sequence: 10,
      message: 'Getting Cloudflare ready',
    });
    vi.setSystemTime(30);
    await recordDeploymentActivity({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration,
      sequence: 50,
      message: 'Uploading your app',
    });
    // A step recorded by the attempt before this one must never be shown as this attempt's progress.
    vi.setSystemTime(40);
    await recordDeploymentActivity({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration + 1,
      sequence: 80,
      message: 'Finishing up',
    });

    await expect(latestDeploymentActivity(db, approved.id)).resolves.toEqual({
      sequence: 50,
      message: 'Uploading your app',
      createdAt: 30,
    });
  });

  it("deploys one revision of a project at a time, and a person's other projects alongside it", async () => {
    const first = await approvedDeployment(1);
    const second = await approvedDeployment(2);
    await claimApprovedDeployment({
      db,
      deploymentId: first.id,
      userId: first.userId,
      connectionId: first.connectionId,
      connectionGeneration: first.connectionGeneration,
      executionGeneration: first.executionGeneration,
    });

    await expect(
      claimApprovedDeployment({
        db,
        deploymentId: second.id,
        userId: second.userId,
        connectionId: second.connectionId,
        connectionGeneration: second.connectionGeneration,
        executionGeneration: second.executionGeneration,
      }),
    ).rejects.toBeInstanceOf(DeploymentConcurrencyLimitError);

    const otherProject = await approvedDeployment(3, 'other-project');
    await expect(
      claimApprovedDeployment({
        db,
        deploymentId: otherProject.id,
        userId: otherProject.userId,
        connectionId: otherProject.connectionId,
        connectionGeneration: otherProject.connectionGeneration,
        executionGeneration: otherProject.executionGeneration,
      }),
    ).resolves.toMatchObject({ status: 'provisioning' });
  });

  it('recovers exact deployment writes when D1 commits before losing the acknowledgement', async () => {
    const approved = await create(1);

    vi.setSystemTime(30);
    const claimed = await claimApprovedDeployment({
      db: d1(sqlite, true),
      deploymentId: approved.id,
      userId: approved.userId,
      connectionId: approved.connectionId,
      connectionGeneration: approved.connectionGeneration,
      executionGeneration: approved.executionGeneration,
    });
    expect(claimed).toMatchObject({ status: 'provisioning', updatedAt: 30 });

    await expect(
      transitionDeployment({
        db: d1(sqlite, true),
        deploymentId: claimed.id,
        executionGeneration: claimed.executionGeneration,
        expectedStatus: 'provisioning',
        nextStatus: 'deploying',
        now: 40,
      }),
    ).resolves.toBeUndefined();
    await expect(requireDeployment(db, claimed.id, claimed.userId)).resolves.toMatchObject({
      status: 'deploying',
      updatedAt: 40,
    });

    await transitionDeployment({
      db,
      deploymentId: claimed.id,
      executionGeneration: claimed.executionGeneration,
      expectedStatus: 'deploying',
      nextStatus: 'failed',
      errorCode: 'deployment_failed',
      errorMessage: 'failed',
      now: 50,
    });
    vi.setSystemTime(60);
    await expect(
      prepareDeploymentRetry({
        db: d1(sqlite, true),
        deploymentId: claimed.id,
        userId: claimed.userId,
        connectionId: claimed.connectionId,
        connectionGeneration: claimed.connectionGeneration,
        executionGeneration: claimed.executionGeneration,
      }),
    ).resolves.toMatchObject({
      status: 'approved',
      executionGeneration: 2,
      errorCode: null,
      errorMessage: null,
      updatedAt: 60,
    });
  });

  it.each([1, 2])(
    'recognises its committed claim when read %i after the lost acknowledgement fails',
    async (failing) => {
      const approved = await create(1);

      vi.setSystemTime(30);
      await expect(
        claimApprovedDeployment({
          db: d1(sqlite, true, undefined, failing),
          deploymentId: approved.id,
          userId: approved.userId,
          connectionId: approved.connectionId,
          connectionGeneration: approved.connectionGeneration,
          executionGeneration: approved.executionGeneration,
        }),
      ).resolves.toMatchObject({ status: 'provisioning', updatedAt: 30 });
    },
  );

  it("finds the project's deployment holding its slot, and when its execution last showed work", async () => {
    const approved = await approvedDeployment(1);
    const claim = (deployment: Deployment, now: number) => {
      vi.setSystemTime(now);
      return claimApprovedDeployment({
        db,
        deploymentId: deployment.id,
        userId: deployment.userId,
        connectionId: deployment.connectionId,
        connectionGeneration: deployment.connectionGeneration,
        executionGeneration: deployment.executionGeneration,
      });
    };
    const find = (userId = 'user-1') => findActiveProjectDeployment(db, { userId, projectId: 'project' });
    await expect(find()).resolves.toBeNull();
    const earlier = await claim(approved, 10);
    await transitionDeployment({
      db,
      deploymentId: earlier.id,
      executionGeneration: earlier.executionGeneration,
      expectedStatus: 'provisioning',
      nextStatus: 'failed',
      now: 20,
    });
    vi.setSystemTime(25);
    const holding = await claim(
      await prepareDeploymentRetry({
        db,
        deploymentId: earlier.id,
        userId: earlier.userId,
        connectionId: earlier.connectionId,
        connectionGeneration: earlier.connectionGeneration,
        executionGeneration: earlier.executionGeneration,
      }),
      30,
    );
    await claim(await approvedDeployment(2, 'other-project'), 90);

    await expect(find()).resolves.toEqual({
      id: holding.id,
      executionGeneration: holding.executionGeneration,
      workspaceRevision: 1,
      revision: sourceSha256,
      lastActiveAt: 30,
    });
    expect(holding.executionGeneration).toBe(earlier.executionGeneration + 1);
    await expect(find('user-2')).resolves.toBeNull();
    // A step the earlier execution recorded late says nothing about this one.
    vi.setSystemTime(80);
    await recordDeploymentActivity({
      db,
      deploymentId: earlier.id,
      executionGeneration: earlier.executionGeneration,
      sequence: 50,
      message: 'Uploading your app',
    });
    await expect(find()).resolves.toMatchObject({ lastActiveAt: 30 });
    vi.setSystemTime(45);
    await recordDeploymentActivity({
      db,
      deploymentId: holding.id,
      executionGeneration: holding.executionGeneration,
      sequence: 40,
      message: 'Updating your database',
    });
    await expect(find()).resolves.toMatchObject({ lastActiveAt: 45 });

    await transitionDeployment({
      db,
      deploymentId: holding.id,
      executionGeneration: holding.executionGeneration,
      expectedStatus: 'provisioning',
      nextStatus: 'failed',
      now: 50,
    });
    await expect(find()).resolves.toBeNull();
  });

  it('lets only one of two claims made in the same millisecond have the deployment', async () => {
    const approved = await create(1);
    vi.setSystemTime(30);
    const claim = (database: D1Database) =>
      claimApprovedDeployment({
        db: database,
        deploymentId: approved.id,
        userId: approved.userId,
        connectionId: approved.connectionId,
        connectionGeneration: approved.connectionGeneration,
        executionGeneration: approved.executionGeneration,
      });

    // The other claim lands after this one read the approved record, and before its own write.
    const otherClaim = async () => {
      await claim(db);
    };
    await expect(claim(d1(sqlite, false, otherClaim))).rejects.toEqual(
      new DeploymentStateConflictError('provisioning'),
    );
    await expect(requireDeployment(db, approved.id, approved.userId)).resolves.toMatchObject({
      status: 'provisioning',
      updatedAt: 30,
    });
  });

  it('returns a failed deployment to the executable state without artifact cleanup', async () => {
    const approved = await approvedDeployment(1);
    vi.setSystemTime(30);
    await claimApprovedDeployment({
      db,
      deploymentId: approved.id,
      userId: approved.userId,
      connectionId: approved.connectionId,
      connectionGeneration: approved.connectionGeneration,
      executionGeneration: approved.executionGeneration,
    });
    await transitionDeployment({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration,
      expectedStatus: 'provisioning',
      nextStatus: 'failed',
      errorCode: 'deployment_provisioning_failed',
      errorMessage: 'failed',
      now: 40,
    });

    vi.setSystemTime(50);
    await expect(
      prepareDeploymentRetry({
        db,
        deploymentId: approved.id,
        userId: approved.userId,
        connectionId: approved.connectionId,
        connectionGeneration: approved.connectionGeneration,
        executionGeneration: approved.executionGeneration,
      }),
    ).resolves.toMatchObject({
      status: 'approved',
      executionGeneration: 2,
      errorCode: null,
      errorMessage: null,
    });
  });
});

async function create(index: number, project = 'project') {
  vi.setSystemTime(index);
  return createDeployment({
    db,
    id: `deployment-${index}`,
    workspaceId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    workspaceReference: `workspace-runtime:${project}:${index}:${sourceSha256}`,
    plan: { ...plan, deploymentId: `deployment-${index}` },
    planDigest,
  });
}

async function approvedDeployment(index: number, project?: string) {
  return create(index, project);
}

/**
 * `beforeNextRun` runs once, just before the next write, as another request landing then would. With
 * `throwAfterNextRun`, the `failingRead`th read after the lost acknowledgement fails too.
 */
function d1(
  database: DatabaseSync,
  throwAfterNextRun = false,
  beforeNextRun?: () => Promise<void>,
  failingRead?: number,
): D1Database {
  let acknowledgementLost = false;
  let readsSinceLost = 0;
  return {
    prepare(query: string) {
      const beforeRun = beforeNextRun;
      return prepared(
        database.prepare(query),
        () => {
          if (!throwAfterNextRun) {
            return;
          }
          throwAfterNextRun = false;
          acknowledgementLost = true;
          throw new Error('D1 acknowledgement lost');
        },
        beforeRun &&
          (() => {
            beforeNextRun = undefined;
            return beforeRun();
          }),
        () => {
          if (acknowledgementLost && (readsSinceLost += 1) === failingRead) {
            throw new Error('D1 read failed');
          }
        },
      );
    },
  } as unknown as D1Database;
}

function prepared(
  statement: StatementSync,
  afterRun?: () => void,
  beforeRun?: () => Promise<void>,
  beforeRead?: () => void,
) {
  let values: SQLInputValue[] = [];
  return {
    bind(...next: SQLInputValue[]) {
      values = next;
      return this;
    },
    async run() {
      await beforeRun?.();
      const result = statement.run(...values);
      afterRun?.();
      return { meta: { changes: Number(result.changes) } };
    },
    async first<T>() {
      beforeRead?.();
      return (statement.get(...values) as T | undefined) ?? null;
    },
    async all<T>() {
      return { results: statement.all(...values) as T[] };
    },
  };
}
