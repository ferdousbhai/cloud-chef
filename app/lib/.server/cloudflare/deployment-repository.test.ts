import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimApprovedDeployment,
  createDeployment,
  DeploymentConcurrencyLimitError,
  latestDeploymentActivity,
  listDeploymentActivity,
  prepareDeploymentRetry,
  recordDeploymentActivity,
  requireDeploymentForUser,
  transitionDeployment,
} from './deployment-repository';
import type { DeploymentPlan } from './deployment-plan';

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
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync('user-workspace-migrations/0001_user_workspace.sql', 'utf8'));
  sqlite.exec(readFileSync('user-workspace-migrations/0005_deployment_activity.sql', 'utf8'));
  sqlite
    .prepare(
      `INSERT INTO chats (id, creator_id, initial_id, timestamp) VALUES ('chat-1', 'user-1', 'initial-1', 'now')`,
    )
    .run();
  db = d1(sqlite);
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

    await expect(requireDeploymentForUser(db, 'deployment-1', 'user-1')).rejects.toThrow();
  });

  it('claims and completes the exact connection-bound execution', async () => {
    const approved = await create(1);
    expect(approved).toMatchObject({ status: 'approved', executionGeneration: 1 });

    const claimed = await claimApprovedDeployment({
      db,
      deploymentId: approved.id,
      userId: approved.userId,
      connectionId: approved.connectionId,
      connectionGeneration: approved.connectionGeneration,
      executionGeneration: approved.executionGeneration,
      now: 30,
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

    await expect(requireDeploymentForUser(db, claimed.id, claimed.userId)).resolves.toMatchObject({
      status: 'succeeded',
      productionUrl: 'https://app.example.workers.dev',
    });
  });

  it('records ordered activity independently for each retry generation', async () => {
    const approved = await approvedDeployment(1);
    await recordDeploymentActivity({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration,
      sequence: 20,
      message: 'Cloudflare resources ready',
      now: 22,
    });
    await recordDeploymentActivity({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration,
      sequence: 10,
      message: 'Preparing Cloudflare resources',
      now: 21,
    });

    await expect(listDeploymentActivity(db, approved.id, approved.executionGeneration)).resolves.toEqual([
      { sequence: 10, message: 'Preparing Cloudflare resources', createdAt: 21 },
      { sequence: 20, message: 'Cloudflare resources ready', createdAt: 22 },
    ]);
    await expect(listDeploymentActivity(db, approved.id, approved.executionGeneration + 1)).resolves.toEqual([]);
  });

  it('reads back the step the current execution recorded most recently', async () => {
    const approved = await approvedDeployment(1);
    await recordDeploymentActivity({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration,
      sequence: 10,
      message: 'Preparing Cloudflare resources',
      now: 21,
    });
    await recordDeploymentActivity({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration,
      sequence: 50,
      message: 'Uploading assets and publishing Worker',
      now: 30,
    });
    // A step recorded by the attempt before this one must never be shown as this attempt's progress.
    await recordDeploymentActivity({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration + 1,
      sequence: 80,
      message: 'Deployment complete',
      now: 40,
    });

    await expect(latestDeploymentActivity(db, approved.id)).resolves.toEqual({
      sequence: 50,
      message: 'Uploading assets and publishing Worker',
      createdAt: 30,
    });
  });

  it('allows only one active deployment per user', async () => {
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
  });

  it('recovers exact deployment writes when D1 commits before losing the acknowledgement', async () => {
    const approved = await create(1);

    const claimed = await claimApprovedDeployment({
      db: d1(sqlite, true),
      deploymentId: approved.id,
      userId: approved.userId,
      connectionId: approved.connectionId,
      connectionGeneration: approved.connectionGeneration,
      executionGeneration: approved.executionGeneration,
      now: 30,
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
    await expect(requireDeploymentForUser(db, claimed.id, claimed.userId)).resolves.toMatchObject({
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
    await expect(
      prepareDeploymentRetry({
        db: d1(sqlite, true),
        deploymentId: claimed.id,
        userId: claimed.userId,
        connectionId: claimed.connectionId,
        connectionGeneration: claimed.connectionGeneration,
        executionGeneration: claimed.executionGeneration,
        now: 60,
      }),
    ).resolves.toMatchObject({
      status: 'approved',
      executionGeneration: 2,
      errorCode: null,
      errorMessage: null,
      updatedAt: 60,
    });
  });

  it('returns a failed deployment to the executable state without artifact cleanup', async () => {
    const approved = await approvedDeployment(1);
    await claimApprovedDeployment({
      db,
      deploymentId: approved.id,
      userId: approved.userId,
      connectionId: approved.connectionId,
      connectionGeneration: approved.connectionGeneration,
      executionGeneration: approved.executionGeneration,
      now: 30,
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

    await expect(
      prepareDeploymentRetry({
        db,
        deploymentId: approved.id,
        userId: approved.userId,
        connectionId: approved.connectionId,
        connectionGeneration: approved.connectionGeneration,
        executionGeneration: approved.executionGeneration,
        now: 50,
      }),
    ).resolves.toMatchObject({
      status: 'approved',
      executionGeneration: 2,
      errorCode: null,
      errorMessage: null,
    });
  });
});

async function create(index: number) {
  return createDeployment({
    db,
    id: `deployment-${index}`,
    chatId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    workspaceReference: `workspace-runtime:project:${index}:${sourceSha256}`,
    plan: { ...plan, deploymentId: `deployment-${index}` },
    planDigest,
    now: index,
  });
}

async function approvedDeployment(index: number) {
  return create(index);
}

function d1(database: DatabaseSync, throwAfterNextRun = false): D1Database {
  return {
    prepare(query: string) {
      return prepared(database.prepare(query), () => {
        if (!throwAfterNextRun) {
          return;
        }
        throwAfterNextRun = false;
        throw new Error('D1 acknowledgement lost');
      });
    },
  } as unknown as D1Database;
}

function prepared(statement: StatementSync, afterRun?: () => void) {
  let values: SQLInputValue[] = [];
  return {
    bind(...next: SQLInputValue[]) {
      values = next;
      return this;
    },
    async run() {
      const result = statement.run(...values);
      afterRun?.();
      return { meta: { changes: Number(result.changes) } };
    },
    async first<T>() {
      return (statement.get(...values) as T | undefined) ?? null;
    },
    async all<T>() {
      return { results: statement.all(...values) as T[] };
    },
  };
}
