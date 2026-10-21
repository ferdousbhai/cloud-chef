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
  projectResourceNaming,
  recordDeploymentActivity,
  requireDeploymentForUser,
  transitionDeployment,
} from './deployment-repository';
import { appResourceIdentity } from '~/lib/cloudflare/app-resource-names';
import { buildDeploymentPlanFromSource, planNamesProjectResources, type DeploymentPlan } from './deployment-plan';

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

describe('project resource naming', () => {
  const reference = {
    userId: 'user-1',
    chatId: 'chat-1',
    workspaceReference: `workspace-runtime:project:9:${sourceSha256}`,
  };

  it('names a project nothing has deployed yet after the project alone', async () => {
    // Deployments that never succeeded created nothing production uses.
    stored({ id: 'failed', status: 'failed', updatedAt: 5, names: { app: 'cloudchef-failed' } });
    stored({ id: 'approved', status: 'approved', updatedAt: 6, names: { app: 'cloudchef-approved' } });

    await expect(projectResourceNaming(db, reference)).resolves.toEqual({
      identity: await appResourceIdentity('project'),
      adopted: [],
    });
  });

  it('keeps each resource as the latest succeeded deployment that has it named it', async () => {
    stored({
      id: 'oldest',
      status: 'succeeded',
      updatedAt: 10,
      names: { app: 'cloudchef-oldest', DB: 'cloudchef-oldest', APP_STORAGE: 'cloudchef-oldest-storage' },
    });
    stored({
      id: 'latest',
      status: 'succeeded',
      updatedAt: 30,
      names: { app: 'cloudchef-latest', DB: 'cloudchef-latest' },
    });
    // Created later but succeeded earlier: production moved on from it.
    stored({ id: 'zz-created-last', status: 'succeeded', updatedAt: 20, names: { app: 'cloudchef-middle' } });
    stored({ id: 'running', status: 'deploying', updatedAt: 40, names: { app: 'cloudchef-running' } });
    // Another project, another person's, and another chat's deployments name their own.
    stored({ id: 'other-project', status: 'succeeded', updatedAt: 50, names: { app: 'x-1' }, project: 'other' });
    stored({ id: 'project-prefix', status: 'succeeded', updatedAt: 50, names: { app: 'x-2' }, project: 'projectx' });
    stored({ id: 'other-user', status: 'succeeded', updatedAt: 50, names: { app: 'x-3' }, userId: 'user-2' });
    stored({ id: 'other-chat', status: 'succeeded', updatedAt: 50, names: { app: 'x-4' }, chatId: 'chat-2' });

    const naming = await projectResourceNaming(db, reference);

    expect(naming.identity).toBe(await appResourceIdentity('project'));
    expect(sortedAdoptions(naming.adopted)).toEqual([
      { type: 'd1', logicalName: 'DB', name: 'cloudchef-latest' },
      { type: 'r2', logicalName: 'APP_STORAGE', name: 'cloudchef-oldest-storage' },
      { type: 'worker', logicalName: 'app', name: 'cloudchef-latest' },
    ]);
  });

  it('breaks a tie between deployments that succeeded together the same way every time', async () => {
    stored({ id: 'deployment-a', status: 'succeeded', updatedAt: 10, names: { app: 'cloudchef-a' } });
    stored({ id: 'deployment-b', status: 'succeeded', updatedAt: 10, names: { app: 'cloudchef-b' } });

    await expect(projectResourceNaming(db, reference)).resolves.toMatchObject({
      adopted: [{ type: 'worker', logicalName: 'app', name: 'cloudchef-b' }],
    });
  });

  it('adopts only account resources, by their type', async () => {
    sqlite
      .prepare(
        `INSERT INTO deployments (
           id, chat_id, user_id, connection_id, connection_generation, workspace_reference,
           status, plan_json, plan_digest, created_at, updated_at
         ) VALUES ('bindings', 'chat-1', 'user-1', 'connection-1', 1, ?, 'succeeded', ?, 'digest', 1, 1)`,
      )
      .run(
        `workspace-runtime:project:1:${sourceSha256}`,
        JSON.stringify({
          ...plan,
          resources: [
            { type: 'durable_object', logicalName: 'AppAgent', proposedName: 'AppAgent' },
            { type: 'd1', logicalName: 'app', proposedName: 'cloudchef-misfiled' },
            { type: 'worker', logicalName: 'app', proposedName: 'cloudchef-bindings' },
          ],
        }),
      );

    await expect(projectResourceNaming(db, reference)).resolves.toMatchObject({
      adopted: [{ type: 'worker', logicalName: 'app', name: 'cloudchef-bindings' }],
    });
  });

  it('plans the next revision of an app deployed before onto that deployment’s resources, and only it', async () => {
    stored({
      id: 'earlier',
      status: 'succeeded',
      updatedAt: 10,
      names: { app: 'cloudchef-earlier', DB: 'cloudchef-earlier', DB_PREVIEW: 'cloudchef-earlier-preview' },
    });
    // Planned when each deployment named its own resources, and never deployed.
    stored({
      id: 'stale',
      status: 'failed',
      updatedAt: 11,
      names: { app: 'cloudchef-stale', DB: 'cloudchef-stale', DB_PREVIEW: 'cloudchef-stale-preview' },
    });
    const project = {
      type: 'web_app' as const,
      bindings: { ai: false, d1: true, r2: false, kv: false, appAgent: false },
    };
    const { plan: next } = await buildDeploymentPlanFromSource({
      deploymentId: 'next',
      sourceSha256,
      project,
      naming: await projectResourceNaming(db, reference),
    });
    const stale = await requireDeploymentForUser(db, 'stale', 'user-1');

    expect(next.resources.map(({ proposedName }) => proposedName)).toEqual([
      'cloudchef-earlier',
      'cloudchef-earlier',
      'cloudchef-earlier-preview',
    ]);
    expect(planNamesProjectResources(next, await projectResourceNaming(db, reference))).toBe(true);
    expect(planNamesProjectResources(stale.plan, await projectResourceNaming(db, reference))).toBe(false);
  });

  it('refuses a reference that is not a CloudChef project’s', async () => {
    await expect(projectResourceNaming(db, { ...reference, workspaceReference: 'github:ada/site' })).rejects.toThrow(
      'does not belong to a CloudChef project',
    );
  });
});

const RESOURCE_TYPES = {
  app: 'worker',
  DB: 'd1',
  DB_PREVIEW: 'd1',
  APP_STORAGE: 'r2',
  APP_CACHE: 'kv',
} as const;

/** A deployment recorded as it is, with the account resource names its plan gives. */
function stored(args: {
  id: string;
  status: 'approved' | 'deploying' | 'succeeded' | 'failed';
  updatedAt: number;
  names: Partial<Record<keyof typeof RESOURCE_TYPES, string>>;
  project?: string;
  userId?: string;
  chatId?: string;
}) {
  if (args.chatId) {
    sqlite
      .prepare(`INSERT OR IGNORE INTO chats (id, creator_id, initial_id, timestamp) VALUES (?, 'user-1', ?, 'now')`)
      .run(args.chatId, `initial-${args.chatId}`);
  }
  const resources = Object.entries(args.names).flatMap(([logicalName, proposedName]) => {
    const type = Object.entries(RESOURCE_TYPES).find(([name]) => name === logicalName)?.[1];
    return type ? [{ type, logicalName, proposedName }] : [];
  });
  sqlite
    .prepare(
      `INSERT INTO deployments (
         id, chat_id, user_id, connection_id, connection_generation, workspace_reference,
         status, plan_json, plan_digest, created_at, updated_at
       ) VALUES (?, ?, ?, 'connection-1', 1, ?, ?, ?, 'digest', 1, ?)`,
    )
    .run(
      args.id,
      args.chatId ?? 'chat-1',
      args.userId ?? 'user-1',
      `workspace-runtime:${args.project ?? 'project'}:1:${sourceSha256}`,
      args.status,
      JSON.stringify({ ...plan, deploymentId: args.id, resources }),
      args.updatedAt,
    );
}

function sortedAdoptions(adopted: readonly { type: string; logicalName: string; name: string }[]) {
  return [...adopted].sort((left, right) =>
    `${left.type}:${left.logicalName}`.localeCompare(`${right.type}:${right.logicalName}`),
  );
}

async function create(index: number, project = 'project') {
  return createDeployment({
    db,
    id: `deployment-${index}`,
    chatId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    workspaceReference: `workspace-runtime:${project}:${index}:${sourceSha256}`,
    plan: { ...plan, deploymentId: `deployment-${index}` },
    planDigest,
    now: index,
  });
}

async function approvedDeployment(index: number, project?: string) {
  return create(index, project);
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
