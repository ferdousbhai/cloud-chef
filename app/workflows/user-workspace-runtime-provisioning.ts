import { canUseConnection } from '~/lib/cloudflare/data/organization-access.server';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  USER_WORKSPACE_DATA_MIGRATIONS,
  USER_WORKSPACE_RUNTIME_SHA256,
  USER_WORKSPACE_RUNTIME_SOURCE,
} from '~/generated/user-workspace-runtime.generated';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import {
  requireActiveCloudflareConnection,
  type CloudflareConnection,
} from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import { waitForUserWorkspaceRuntimeReadiness } from '~/lib/.server/cloudflare/user-workspace-runtime-readiness';
import {
  findUserWorkspaceRuntime,
  upsertUserWorkspaceRuntime,
} from '~/lib/.server/cloudflare/user-workspace-runtime-repository';
import { claimUserWorkspaceRuntimeUpgradeWindow } from '~/lib/.server/cloudflare/user-workspace-runtime-upgrade-window';
import { RUNTIME_BUSY_LEASE_MS } from '~/lib/.server/cloudflare/user-workspace-runtime-activity';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { sha256Hex } from '~/lib/hex-digest';
import { z } from 'zod';

export const USER_WORKSPACE_SANDBOX_BASE_IMAGE =
  'docker.io/cloudflare/sandbox:0.13.0-next.724.1@sha256:d5856e09ccb02c2cd00f73946360369d5655faa9b67b156e0d8627bf143619f1';

export const USER_WORKSPACE_REQUIRED_CAPABILITIES = [
  'workers',
  'containers',
  'd1',
  'r2',
  'kv',
  'durable_objects',
  'workers_ai',
] as const;

type ProvisioningParams = {
  userId: string;
  connectionId: string;
  connectionGeneration: number;
};

export type UserWorkspaceRuntimeProvisioningErrorCode =
  'workspace_plan_required' | 'workspace_eligibility_unknown' | 'workspace_preparation_failed';

type ProvisioningError = {
  status: 'error';
  errorCode: UserWorkspaceRuntimeProvisioningErrorCode;
  upgradeUrl: string | null;
};

const provisioningErrorSchema = z.object({
  status: z.literal('error'),
  errorCode: z.enum(['workspace_plan_required', 'workspace_eligibility_unknown', 'workspace_preparation_failed']),
  upgradeUrl: z.string().nullable().optional(),
});

/**
 * `deferred`: the live runtime never went quiet for long enough to upgrade it before the Workflow gave
 * up waiting. It keeps working, and the next session request starts the wait again.
 */
export type UserWorkspaceRuntimeProvisioningResult = { status: 'ready' } | { status: 'deferred' } | ProvisioningError;
export type UserWorkspaceRuntimeProvisioningLaunchResult = { status: 'preparing' } | ProvisioningError;

const STEP_CONFIG = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} as const;
const LONG_STEP_CONFIG = {
  retries: { limit: 7, delay: '15 seconds', backoff: 'exponential' },
  timeout: '30 minutes',
} as const;

/** The first wait for a busy workspace, doubled each time it is still busy, up to the longest. */
const UPGRADE_FIRST_WAIT_MS = 30_000;
const UPGRADE_LONGEST_WAIT_MS = 5 * 60_000;
/**
 * How long one Workflow waits for a workspace to go quiet. Past it the Workflow ends without upgrading,
 * and the next session request starts another; it never upgrades a busy workspace.
 */
export const UPGRADE_MAX_WAIT_MS = 12 * 60 * 60_000;
/**
 * A runtime too old to report its activity is upgraded only once no session was issued for it for
 * longer than a turn can run, since a turn needs a session to start and runs at most that long.
 */
export const LEGACY_RUNTIME_QUIET_MS = RUNTIME_BUSY_LEASE_MS;
const LEGACY_RUNTIME_LONGEST_WAIT_MS = 30 * 60_000;

export type UserWorkspaceRuntimeProvisioningStep = {
  do<T>(name: string, config: typeof STEP_CONFIG | typeof LONG_STEP_CONFIG, operation: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: number): Promise<void>;
};

/** What a deploy attempt found: deployed, or a live workspace still busy, to try again after `waitMs`. */
type DeployAttempt =
  { status: 'deployed'; namespaceId: string } | { status: 'busy'; checkedAt: number; waitMs: number };

type ProvisioningAccountApi = Pick<
  UserCloudflareAccountApi,
  | 'readWorkspaceContainersEntitlement'
  | 'getWorkersSubdomain'
  | 'ensureD1Database'
  | 'applyD1Migrations'
  | 'deployWorkspaceRuntimeWorker'
  | 'configureWorkspaceRuntimeGcSchedule'
  | 'enableWorkerSubdomain'
  | 'ensureWorkspaceRuntimeContainer'
>;

export type UserWorkspaceRuntimeProvisioningDependencies = {
  requireConnection: typeof requireActiveCloudflareConnection;
  resolveCredential(env: Env, handle: string): Promise<string>;
  createAccountApi(accountId: string, accessToken: string): ProvisioningAccountApi;
  deriveSecret: typeof deriveUserWorkspaceRuntimeSecret;
  waitForReadiness: typeof waitForUserWorkspaceRuntimeReadiness;
  upsertRuntime: typeof upsertUserWorkspaceRuntime;
  findRuntime: typeof findUserWorkspaceRuntime;
  claimUpgradeWindow: typeof claimUserWorkspaceRuntimeUpgradeWindow;
  now: () => number;
};

const provisioningDependencies: UserWorkspaceRuntimeProvisioningDependencies = {
  requireConnection: requireActiveCloudflareConnection,
  resolveCredential: (env, handle) => D1CloudflareCredentialVault.fromEnv(env).resolve(handle),
  createAccountApi: (accountId, accessToken) => new UserCloudflareAccountApi(accountId, accessToken),
  deriveSecret: deriveUserWorkspaceRuntimeSecret,
  waitForReadiness: waitForUserWorkspaceRuntimeReadiness,
  upsertRuntime: upsertUserWorkspaceRuntime,
  findRuntime: findUserWorkspaceRuntime,
  claimUpgradeWindow: claimUserWorkspaceRuntimeUpgradeWindow,
  now: Date.now,
};

/** Start or inspect the one durable Workflow for this connection and runtime build. */
/**
 * The resources of one person's workspace in one Cloudflare account. Named from the account and the
 * person, so members of an organization each get their own in its shared account, and removing a
 * member can find theirs again.
 */
export async function workspaceRuntimeNames(
  connection: { accountId: string; id: string; orgId: string | null },
  userId: string,
): Promise<{ workerName: string; databaseName: string }> {
  // A person's own workspace keeps the name it always had; an organization's also names the
  // connection, so it never collides with their own in the same Cloudflare account.
  const seed = connection.orgId
    ? `${connection.accountId}:${userId}:${connection.id}`
    : `${connection.accountId}:${userId}`;
  const suffix = (await sha256Hex(seed)).slice(0, 16);
  return { workerName: `cloudchef-workspace-${suffix}`, databaseName: `cloudchef-data-${suffix}` };
}

export async function startUserWorkspaceRuntimeProvisioning(args: {
  env: Pick<Env, 'USER_WORKSPACE_RUNTIME_PROVISIONING'>;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  retry?: boolean;
  /** Whether the ready workspace is there after all; read again before rebuilding a finished one. */
  isReady?: () => Promise<boolean>;
}): Promise<UserWorkspaceRuntimeProvisioningLaunchResult> {
  const params: ProvisioningParams = {
    userId: args.userId,
    connectionId: args.connectionId,
    connectionGeneration: args.connectionGeneration,
  };
  // One Workflow per person per connection: members of an organization share its connection, and each
  // gets their own workspace in its account.
  const id = `workspace-${await sha256Hex(
    `${params.userId}\0${params.connectionId}\0${params.connectionGeneration}\0${USER_WORKSPACE_RUNTIME_SHA256}\0${USER_WORKSPACE_SANDBOX_BASE_IMAGE}`,
  )}`;
  try {
    const { created } = await args.env.USER_WORKSPACE_RUNTIME_PROVISIONING.createBatch({
      instances: [{ id, params, retention: { successRetention: '1 day', errorRetention: '1 day' } }],
    });
    if (created.length > 0) {
      return { status: 'preparing' };
    }
  } catch {
    // An existing id is the ordinary case on every poll after the first for this connection
    // generation and runtime build. The object form reports it as a per-instance error and the
    // binding has also thrown for it, so either way inspecting the existing instance is the answer,
    // not a preparation failure.
  }

  const instance = await args.env.USER_WORKSPACE_RUNTIME_PROVISIONING.get(id);
  const status = await instance.status();
  const parsedError = provisioningErrorSchema.safeParse(status.output);
  const error: ProvisioningError | null = parsedError.success
    ? { ...parsedError.data, upgradeUrl: parsedError.data.upgradeUrl ?? null }
    : null;
  if (args.retry && (status.status === 'errored' || status.status === 'terminated' || error)) {
    await instance.restart();
    return { status: 'preparing' };
  }
  if (error) {
    return error;
  }
  // Finished and ready, yet the caller found no ready workspace: it was removed since, say when its
  // owner left an organization and was invited back. Build it again rather than wait forever.
  if (status.status === 'complete') {
    // It may have finished just after the caller looked: then the next poll finds it ready.
    if (!(await args.isReady?.())) {
      await instance.restart();
    }
    return { status: 'preparing' };
  }
  return status.status === 'errored' || status.status === 'terminated'
    ? { status: 'error', errorCode: 'workspace_preparation_failed', upgradeUrl: null }
    : { status: 'preparing' };
}

export class UserWorkspaceRuntimeProvisioningWorkflow extends WorkflowEntrypoint<Env, ProvisioningParams> {
  override async run(
    event: Readonly<WorkflowEvent<ProvisioningParams>>,
    step: WorkflowStep,
  ): Promise<UserWorkspaceRuntimeProvisioningResult> {
    return runUserWorkspaceRuntimeProvisioningWorkflow({ env: this.env, event, step });
  }
}

/** Provision the user-owned D1, Worker, and Sandbox container as one durable sequence. */
export async function runUserWorkspaceRuntimeProvisioningWorkflow(args: {
  env: Env;
  event: { payload: ProvisioningParams };
  step: UserWorkspaceRuntimeProvisioningStep;
  dependencies?: UserWorkspaceRuntimeProvisioningDependencies;
}): Promise<UserWorkspaceRuntimeProvisioningResult> {
  try {
    const dependencies = args.dependencies ?? provisioningDependencies;
    const params = args.event.payload;
    const connection = await expectedConnection(args.env, params, dependencies.requireConnection);
    const accessToken = await dependencies.resolveCredential(args.env, connection.credentialHandle);
    const accountApi = dependencies.createAccountApi(connection.accountId, accessToken);
    const { workerName, databaseName } = await workspaceRuntimeNames(connection, params.userId);

    const inspection = await args.step.do('inspect account', STEP_CONFIG, async () => {
      const entitlement = await accountApi.readWorkspaceContainersEntitlement();
      if (entitlement.status !== 'entitled') {
        return entitlement;
      }
      return { status: 'entitled' as const, workersSubdomain: await accountApi.getWorkersSubdomain() };
    });
    if (inspection.status === 'plan_required') {
      return { status: 'error', errorCode: 'workspace_plan_required', upgradeUrl: inspection.upgradeUrl };
    }
    if (inspection.status === 'undetermined') {
      return { status: 'error', errorCode: 'workspace_eligibility_unknown', upgradeUrl: null };
    }

    const endpoint = `https://${workerName}.${inspection.workersSubdomain}.workers.dev`;
    const controlPlaneSecret = await dependencies.deriveSecret({
      encryptionKeyBase64: args.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY,
      userId: params.userId,
      accountId: connection.accountId,
      connectionGeneration: params.connectionGeneration,
      organizationConnectionId: connection.orgId ? connection.id : null,
    });
    const databaseId = await args.step.do('prepare workspace database', STEP_CONFIG, async () => {
      const database = await accountApi.ensureD1Database(databaseName);
      await accountApi.applyD1Migrations(database.id, USER_WORKSPACE_DATA_MIGRATIONS);
      return database.id;
    });
    // A runtime already serving this connection generation is an upgrade: redeploying it resets its
    // Durable Objects, so it waits for a moment when none of them is working.
    const upgradeStartedAt = await args.step.do('inspect live workspace', STEP_CONFIG, async () => {
      const live = await dependencies.findRuntime(args.env.DB, params.userId, connection.id);
      return live && live.connectionGeneration === params.connectionGeneration && live.endpoint === endpoint
        ? dependencies.now()
        : null;
    });
    let namespaceId: string;
    for (let attempt = 0; ; attempt += 1) {
      const outcome: DeployAttempt = await args.step.do(
        `deploy workspace Worker (attempt ${attempt + 1})`,
        STEP_CONFIG,
        async () => {
          // Asked again here and before the locator is written: a member removed from their organization
          // while this ran must not get their workspace back.
          await expectedConnection(args.env, params, dependencies.requireConnection);
          if (upgradeStartedAt !== null) {
            const waitMs = await waitBeforeUpgrade({
              dependencies,
              db: args.env.DB,
              params,
              endpoint,
              controlPlaneSecret,
              attempt,
            });
            if (waitMs !== null) {
              return { status: 'busy', checkedAt: dependencies.now(), waitMs };
            }
          }
          const deployed = await accountApi.deployWorkspaceRuntimeWorker({
            workerName,
            source: USER_WORKSPACE_RUNTIME_SOURCE,
            controlPlaneSecret,
            runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
            databaseId,
            userId: params.userId,
            connectionId: connection.id,
            connectionGeneration: connection.generation,
            oauthScopeGrantStatus: connection.oauthScopeGrantStatus,
            endpoint,
            sharedAccount: connection.orgId !== null,
          });
          await Promise.all([
            accountApi.configureWorkspaceRuntimeGcSchedule(workerName),
            accountApi.enableWorkerSubdomain(workerName),
          ]);
          return { status: 'deployed', namespaceId: deployed.namespaceId };
        },
      );
      if (outcome.status === 'deployed') {
        namespaceId = outcome.namespaceId;
        break;
      }
      if (upgradeStartedAt !== null && outcome.checkedAt - upgradeStartedAt >= UPGRADE_MAX_WAIT_MS) {
        console.warn({ event: 'runtime_upgrade_deferred', reason: 'workspace_never_idle', attempts: attempt + 1 });
        return { status: 'deferred' };
      }
      await args.step.sleep(`wait for an idle workspace (attempt ${attempt + 1})`, outcome.waitMs);
    }
    await args.step.do('deploy Sandbox container', LONG_STEP_CONFIG, () =>
      accountApi.ensureWorkspaceRuntimeContainer({
        applicationName: workerName,
        namespaceId,
        image: USER_WORKSPACE_SANDBOX_BASE_IMAGE,
      }),
    );
    await args.step.do('wait for workspace', LONG_STEP_CONFIG, () =>
      dependencies.waitForReadiness({
        endpoint,
        controlPlaneSecret,
        runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
        request: fetch,
      }),
    );
    await args.step.do('mark workspace ready', STEP_CONFIG, async () => {
      await expectedConnection(args.env, params, dependencies.requireConnection);
      await dependencies.upsertRuntime({
        db: args.env.DB,
        userId: params.userId,
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        workerName,
        endpoint,
        runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
        imageDigest: USER_WORKSPACE_SANDBOX_BASE_IMAGE,
        protocolVersion: USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
      });
    });
    return { status: 'ready' };
  } catch (error) {
    // Only the message is logged: the thrown messages on this path are fixed, while the error
    // object can carry a `cause` from parsing a decrypted credential, which must not reach a log.
    console.error('Workspace runtime provisioning failed', error instanceof Error ? error.message : 'Unknown error');
    return { status: 'error', errorCode: 'workspace_preparation_failed', upgradeUrl: null };
  }
}

/**
 * How long to wait before trying to upgrade a live workspace again, or null to upgrade it now. A
 * runtime that reports its activity is asked for the upgrade window, granted only while nothing in it
 * runs; one too old to report it is upgraded once no session was issued for it for longer than any
 * turn runs.
 */
async function waitBeforeUpgrade(args: {
  dependencies: UserWorkspaceRuntimeProvisioningDependencies;
  db: D1Database;
  params: ProvisioningParams;
  endpoint: string;
  controlPlaneSecret: string;
  attempt: number;
}): Promise<number | null> {
  const window = await args.dependencies.claimUpgradeWindow({
    endpoint: args.endpoint,
    controlPlaneSecret: args.controlPlaneSecret,
    targetVersion: USER_WORKSPACE_RUNTIME_SHA256,
  });
  if (window.status === 'granted') {
    return null;
  }
  if (window.status === 'busy') {
    console.info({ event: 'runtime_upgrade_waiting', reason: 'workspace_busy', busy: window.busy });
    return Math.min(UPGRADE_FIRST_WAIT_MS * 2 ** Math.min(args.attempt, 10), UPGRADE_LONGEST_WAIT_MS);
  }
  const live = await args.dependencies.findRuntime(args.db, args.params.userId, args.params.connectionId);
  const quietFor = args.dependencies.now() - (live?.lastSessionAt ?? 0);
  if (quietFor >= LEGACY_RUNTIME_QUIET_MS) {
    return null;
  }
  console.info({ event: 'runtime_upgrade_waiting', reason: 'legacy_runtime_recently_used' });
  return Math.min(LEGACY_RUNTIME_QUIET_MS - quietFor, LEGACY_RUNTIME_LONGEST_WAIT_MS);
}

async function expectedConnection(
  env: Env,
  params: ProvisioningParams,
  requireConnection: typeof requireActiveCloudflareConnection,
) {
  if (!env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error('Cloudflare credential encryption is not configured.');
  }
  const connection = await requireConnection(env.DB, params.connectionId);
  if (
    !(await canUseConnection(env.DB, params.userId, connection)) ||
    connection.generation !== params.connectionGeneration ||
    !connection.credentialHandle ||
    missingUserWorkspaceRuntimeCapabilities(connection).length > 0
  ) {
    throw new Error('The Cloudflare connection cannot provision this workspace.');
  }
  return { ...connection, credentialHandle: connection.credentialHandle };
}

export function missingUserWorkspaceRuntimeCapabilities(connection: CloudflareConnection): string[] {
  return USER_WORKSPACE_REQUIRED_CAPABILITIES.filter(
    (capability) => !connection.grantedCapabilities.includes(capability),
  );
}
