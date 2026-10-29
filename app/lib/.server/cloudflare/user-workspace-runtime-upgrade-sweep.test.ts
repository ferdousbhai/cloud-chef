import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { CORE_CLOUDFLARE_OAUTH_SCOPES } from './cloudflare-oauth-scope-manifest';
import { USER_WORKSPACE_IMAGE } from '~/lib/.server/cloudflare/user-workspace-image';
import {
  FAILED_UPGRADE_RESTART_EVERY_SWEEPS,
  sweepUserWorkspaceRuntimeUpgrades,
  UPGRADE_SWEEP_INTERVAL_MS,
  UPGRADE_SWEEP_MAX_LAUNCHES,
} from './user-workspace-runtime-upgrade-sweep';

/** The pin is empty until the image is published; these tests are about the sweep, so it is published here. */
const imagePublished = () => true;

type Status = InstanceStatus['status'];
/** The object form of `createBatch`; the array form is deprecated. */
type CreateBatch = (options: WorkflowBatchCreateOptions<unknown>) => Promise<WorkflowBatchCreateResult>;
const paramsSchema = z.object({ userId: z.string() });

/**
 * The provisioning Workflow binding: `existing` answers the status of each person's instance (by user
 * id), or null for none yet, which `createBatch` then creates. `restarts` lists who was restarted.
 */
function workflows(existing: (userId: string) => Status | null) {
  const ids = new Map<string, string>();
  const created: string[] = [];
  const restarts: string[] = [];
  const createBatch = vi.fn<CreateBatch>(async (options) => {
    const id = options.instances?.[0]?.id ?? '';
    const { userId } = paramsSchema.parse(options.instances?.[0]?.params);
    ids.set(id, userId);
    if (existing(userId)) {
      return { created: [], errors: [{ index: 0, id, code: 409, message: 'instance already exists' }] };
    }
    created.push(userId);
    return { created: [instance(id, 'queued')], errors: [] };
  });
  const objectForm: CreateBatch = createBatch;
  const binding: Env['USER_WORKSPACE_RUNTIME_PROVISIONING'] = {
    create: vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['create']>(),
    // SAFETY: the binding overloads createBatch with its deprecated array form, which the sweep never calls.
    createBatch: objectForm as Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['createBatch'],
    get: vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>(async (id) => {
      const userId = ids.get(id) ?? '';
      return instance(id, existing(userId) ?? 'unknown', () => restarts.push(userId));
    }),
    deleteBatch: vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['deleteBatch']>(),
  };
  return { binding, createBatch, created, restarts };
}

function instance(id: string, status: Status, restart: () => void = () => undefined): WorkflowInstance {
  return {
    id,
    status: async () => ({ status }),
    restart: async () => restart(),
    pause: vi.fn(),
    resume: vi.fn(),
    terminate: vi.fn(),
    sendEvent: vi.fn(),
    delete: vi.fn(),
    subscribe: vi.fn(),
  };
}

/**
 * A control plane whose `add` gives each connection an owner, `owner-of-<id>`, an account of its own,
 * `account-<id>`, with its authorization, and their ready runtime on an earlier build, so it is outdated.
 */
function controlPlane() {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, key_version, created_at)
      VALUES ('handle-1', 'x', 'y', 1, 1);
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org-1', 'Acme', 1, 1);
  `);
  const add = (
    id: string,
    {
      org = false,
      paused = false,
      scopes = [...CORE_CLOUDFLARE_OAUTH_SCOPES],
      credentialHandle = 'handle-1',
    }: { org?: boolean; paused?: boolean; scopes?: string[]; credentialHandle?: string | null } = {},
  ) => {
    const userId = `owner-of-${id}`;
    database
      .prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)`)
      .run(userId, userId, `${id}@example.com`);
    if (org) {
      database
        .prepare(
          `INSERT INTO organization_members (org_id, user_id, role, joined_at, paused_at) VALUES (?, ?, ?, 1, ?)`,
        )
        .run('org-1', userId, 'member', paused ? 2 : null);
    }
    database
      .prepare(
        `INSERT INTO cloudflare_connections (id, user_id, org_id, account_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 1, 1)`,
      )
      .run(id, org ? null : userId, org ? 'org-1' : null, `account-${id}`);
    if (credentialHandle) {
      database
        .prepare(
          `INSERT INTO cloudflare_authorizations (account_id, credential_handle, granted_oauth_scopes_json,
             created_at, updated_at)
           VALUES (?, ?, ?, 1, 1)`,
        )
        .run(`account-${id}`, credentialHandle, JSON.stringify(scopes));
    }
    database
      .prepare(
        `INSERT INTO user_computer_runtimes
           (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
            created_at, updated_at, image_digest, protocol_version)
         VALUES (?, ?, 1, 'worker', 'https://workspace.example', 'earlier', 'ready', 1, 1, ?, ?)`,
      )
      .run(userId, id, USER_WORKSPACE_IMAGE, USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION);
  };
  const makeCurrent = (id: string) =>
    database
      .prepare('UPDATE user_computer_runtimes SET runtime_version = ? WHERE connection_id = ?')
      .run(USER_WORKSPACE_RUNTIME_SHA256, id);
  /** A reconnect: the connection moves to a new generation, and its runtime's secret stops authenticating. */
  const reconnect = (id: string) =>
    database
      .prepare('UPDATE cloudflare_connections SET connection_generation = connection_generation + 2 WHERE id = ?')
      .run(id);
  const env = (binding: Env['USER_WORKSPACE_RUNTIME_PROVISIONING'], canary = '') =>
    envWith({
      DB: db,
      USER_WORKSPACE_RUNTIME_PROVISIONING: binding,
      // SAFETY: the generated type is the committed value (none); a canary release commits user ids instead.
      WORKSPACE_RUNTIME_UPGRADE_CANARY: canary as Env['WORKSPACE_RUNTIME_UPGRADE_CANARY'],
    });
  return { add, makeCurrent, reconnect, env };
}

describe('scheduled workspace runtime upgrade sweep', () => {
  it('starts the gated upgrade of each outdated runtime this release can still serve', async () => {
    const plane = controlPlane();
    plane.add('a');
    plane.add('b');
    plane.add('current');
    plane.makeCurrent('current');
    const workflow = workflows(() => null);

    await expect(
      sweepUserWorkspaceRuntimeUpgrades({ env: plane.env(workflow.binding), scheduledTime: 0, imagePublished }),
    ).resolves.toMatchObject({ started: 2, skipped: 0 });
    expect(workflow.created).toEqual(['owner-of-a', 'owner-of-b']);
  });

  it('upgrades only the canary runtimes while a canary is named', async () => {
    const plane = controlPlane();
    plane.add('a');
    plane.add('b');
    const workflow = workflows(() => null);

    await expect(
      sweepUserWorkspaceRuntimeUpgrades({
        env: plane.env(workflow.binding, ' owner-of-b ,'),
        scheduledTime: 0,
        imagePublished,
      }),
    ).resolves.toMatchObject({ started: 1, skipped: 1 });
    expect(workflow.created).toEqual(['owner-of-b']);
  });

  it('starts nothing while this release pins no published workspace image', async () => {
    const plane = controlPlane();
    plane.add('a');
    const workflow = workflows(() => null);

    await expect(
      sweepUserWorkspaceRuntimeUpgrades({
        env: plane.env(workflow.binding),
        scheduledTime: 0,
        imagePublished: () => false,
      }),
    ).resolves.toMatchObject({ started: 0, restarted: 0, skipped: 0 });
    expect(workflow.createBatch).not.toHaveBeenCalled();
  });

  it("prepares a runtime a reconnect left behind for the connection's new generation, even on this build", async () => {
    const plane = controlPlane();
    plane.add('reconnected');
    plane.makeCurrent('reconnected');
    plane.reconnect('reconnected');
    const workflow = workflows(() => null);

    await expect(
      sweepUserWorkspaceRuntimeUpgrades({ env: plane.env(workflow.binding), scheduledTime: 0, imagePublished }),
    ).resolves.toMatchObject({ started: 1, skipped: 0 });
    expect(workflow.createBatch.mock.calls[0][0].instances?.[0]?.params).toMatchObject({
      userId: 'owner-of-reconnected',
      connectionGeneration: 3,
    });
  });

  it('launches at most a batch per sweep, not counting upgrades already waiting', async () => {
    const plane = controlPlane();
    for (let index = 0; index < UPGRADE_SWEEP_MAX_LAUNCHES + 5; index += 1) {
      plane.add(`c${index}`);
    }
    // The first two are already waiting for a quiet moment; the rest are launched up to the batch.
    const workflow = workflows((userId) => (userId === 'owner-of-c0' || userId === 'owner-of-c1' ? 'running' : null));

    await expect(
      sweepUserWorkspaceRuntimeUpgrades({ env: plane.env(workflow.binding), scheduledTime: 0, imagePublished }),
    ).resolves.toMatchObject({ running: 2, started: UPGRADE_SWEEP_MAX_LAUNCHES });
    expect(workflow.createBatch).toHaveBeenCalledTimes(UPGRADE_SWEEP_MAX_LAUNCHES + 2);
  });

  it('starts nothing for a person who may no longer use the connection, or one that cannot provision', async () => {
    const plane = controlPlane();
    plane.add('paused', { org: true, paused: true });
    plane.add('missing-scope', { scopes: ['workers-scripts.write'] });
    plane.add('no-credential', { credentialHandle: null });
    const workflow = workflows(() => null);

    await expect(
      sweepUserWorkspaceRuntimeUpgrades({ env: plane.env(workflow.binding), scheduledTime: 0, imagePublished }),
    ).resolves.toMatchObject({ started: 0, skipped: 3 });
    expect(workflow.createBatch).not.toHaveBeenCalled();
  });

  it('retries each failed upgrade on one sweep in four, and keeps sweeping past one that throws', async () => {
    const plane = controlPlane();
    plane.add('failing');
    const failed = workflows(() => 'errored');
    const restartedOn: number[] = [];
    for (let sweep = 0; sweep < FAILED_UPGRADE_RESTART_EVERY_SWEEPS * 2; sweep += 1) {
      const before = failed.restarts.length;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await sweepUserWorkspaceRuntimeUpgrades({
        env: plane.env(failed.binding),
        scheduledTime: sweep * UPGRADE_SWEEP_INTERVAL_MS,
        imagePublished,
      });
      warn.mockRestore();
      if (failed.restarts.length > before) {
        restartedOn.push(sweep);
      }
    }
    expect(restartedOn).toEqual([0, FAILED_UPGRADE_RESTART_EVERY_SWEEPS]);

    const other = controlPlane();
    other.add('throws');
    other.add('fine');
    const workflow = workflows((userId) => {
      if (userId === 'owner-of-throws') {
        throw new Error('Workflow binding unavailable');
      }
      return null;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      sweepUserWorkspaceRuntimeUpgrades({ env: other.env(workflow.binding), scheduledTime: 0, imagePublished }),
    ).resolves.toMatchObject({ started: 1, skipped: 1 });
    expect(warn).toHaveBeenCalledWith({
      event: 'runtime_upgrade_sweep_failed',
      message: 'Workflow binding unavailable',
    });
    warn.mockRestore();
  });

  it('restarts a finished upgrade that left the runtime on an earlier generation, though on this build', async () => {
    const plane = controlPlane();
    plane.add('reconnected');
    plane.makeCurrent('reconnected');
    plane.reconnect('reconnected');
    const workflow = workflows(() => 'complete');

    await expect(
      sweepUserWorkspaceRuntimeUpgrades({ env: plane.env(workflow.binding), scheduledTime: 0, imagePublished }),
    ).resolves.toMatchObject({ restarted: 1, left: 0 });
    expect(workflow.restarts).toEqual(['owner-of-reconnected']);
  });

  it('asks whether the runtime became current before restarting a finished upgrade', async () => {
    const plane = controlPlane();
    plane.add('a');
    // It finished just after the sweep listed the runtime as outdated.
    const workflow = workflows(() => {
      plane.makeCurrent('a');
      return 'complete';
    });

    await expect(
      sweepUserWorkspaceRuntimeUpgrades({ env: plane.env(workflow.binding), scheduledTime: 0, imagePublished }),
    ).resolves.toMatchObject({ left: 1 });
    expect(workflow.restarts).toEqual([]);
  });
});
