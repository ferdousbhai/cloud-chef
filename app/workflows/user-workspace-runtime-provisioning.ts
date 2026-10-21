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
import {
  changeUserWorkspaceRuntimeUpgradeWindow,
  claimUserWorkspaceRuntimeUpgradeWindow,
  RuntimeSecretRefusedError,
  RuntimeUpgradeWindowRefusedError,
} from '~/lib/.server/cloudflare/user-workspace-runtime-upgrade-window';
import {
  RUNTIME_BUSY_LEASE_MS,
  RUNTIME_UPGRADE_WINDOW_MS,
} from '~/lib/.server/cloudflare/user-workspace-runtime-activity';
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

/** A failure after the Worker was redeployed, which left it serving without its container image or schedule. */
const redeployedFailureSchema = z.object({ status: z.literal('error'), redeployed: z.literal(true) });

/**
 * `deferred`: the live runtime never went quiet for long enough to upgrade it before the Workflow gave
 * up waiting. It keeps working, and the next session request starts the wait again. `redeployed`: the
 * failure came after the Worker was redeployed.
 */
export type UserWorkspaceRuntimeProvisioningResult =
  { status: 'ready' } | { status: 'deferred' } | (ProvisioningError & { redeployed?: true });
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
 * How long one Workflow waits for a workspace to go quiet before it redeploys. Past it the Workflow ends
 * without upgrading, and the next session request starts another; it never upgrades a busy workspace.
 * Once it has redeployed the Worker it never gives up this way: the new Worker needs its container
 * image and its schedule, so what follows waits as long as it must.
 */
export const UPGRADE_MAX_WAIT_MS = 12 * 60 * 60_000;
/**
 * A runtime too old to report its activity is upgraded only once no session was issued for it for
 * longer than a turn can run, since a turn needs a session to start and runs at most that long.
 */
export const LEGACY_RUNTIME_QUIET_MS = RUNTIME_BUSY_LEASE_MS;
const LEGACY_RUNTIME_LONGEST_WAIT_MS = 30 * 60_000;
/**
 * How long an upgrade waits for a runtime of an earlier connection generation (a reconnect) to go quiet,
 * from when it found it live, before redeploying it as a first workspace is. Its member gets no session
 * for it meanwhile, since its secret no longer authenticates, so they cannot Stop the turn holding the
 * upgrade back, and a busy row a reset left behind would hold it for the whole lease: waiting longer
 * would lock them out of their workspace for hours.
 */
export const EARLIER_GENERATION_MAX_WAIT_MS = 15 * 60_000;
/** How often an upgrade renews its window while a step that needs it runs: well inside its length. */
export const UPGRADE_WINDOW_RENEWAL_MS = RUNTIME_UPGRADE_WINDOW_MS / 5;

export type UserWorkspaceRuntimeProvisioningStep = {
  do<T>(name: string, config: typeof STEP_CONFIG | typeof LONG_STEP_CONFIG, operation: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: number): Promise<void>;
};

/**
 * What a deploy attempt found: deployed, or a live workspace still busy, to try again after `waitMs`.
 * `windowed: false` is a live runtime of an earlier connection generation that refused both secrets or
 * stayed busy past `EARLIER_GENERATION_MAX_WAIT_MS`, redeployed as a first workspace is; absent, as in
 * a result recorded before, it is as inspected.
 */
type DeployAttempt =
  { status: 'deployed'; namespaceId: string; windowed?: false } | { status: 'busy'; checkedAt: number; waitMs: number };

/**
 * What a step that needs the upgrade window found: done, or work started while the window had lapsed
 * (or another upgrade holds it), to try again after `waitMs`. Undefined is a result recorded before
 * steps reported one: done.
 */
type HeldStepAttempt = { status: 'done' } | { status: 'busy'; checkedAt: number; waitMs: number } | undefined;

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
  changeUpgradeWindow: typeof changeUserWorkspaceRuntimeUpgradeWindow;
  now: () => number;
  /** Waits between renewals of the upgrade window. */
  sleep: (ms: number) => Promise<void>;
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
  changeUpgradeWindow: changeUserWorkspaceRuntimeUpgradeWindow,
  now: Date.now,
  sleep: (ms) => scheduler.wait(ms),
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
  const params = provisioningParams(args);
  const id = await provisioningInstanceId(params);
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
  const error = provisioningErrorOutput(status);
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

function provisioningParams(args: {
  userId: string;
  connectionId: string;
  connectionGeneration: number;
}): ProvisioningParams {
  return { userId: args.userId, connectionId: args.connectionId, connectionGeneration: args.connectionGeneration };
}

/**
 * One Workflow per person per connection and runtime build: members of an organization share its
 * connection, and each gets their own workspace in its account. A session request and the scheduled
 * upgrade sweep name the same instance, so they never start two upgrades of one workspace.
 */
async function provisioningInstanceId(params: ProvisioningParams): Promise<string> {
  return `workspace-${await sha256Hex(
    `${params.userId}\0${params.connectionId}\0${params.connectionGeneration}\0${USER_WORKSPACE_RUNTIME_SHA256}\0${USER_WORKSPACE_SANDBOX_BASE_IMAGE}`,
  )}`;
}

function provisioningErrorOutput(status: InstanceStatus): ProvisioningError | null {
  const parsed = provisioningErrorSchema.safeParse(status.output);
  return parsed.success ? { ...parsed.data, upgradeUrl: parsed.data.upgradeUrl ?? null } : null;
}

/**
 * What the scheduled sweep did for one outdated runtime: started its upgrade Workflow, restarted one
 * that ended without upgrading it, found one still waiting for a quiet moment, or left it alone.
 */
export type UserWorkspaceRuntimeUpgradeSweepOutcome = 'started' | 'restarted' | 'running' | 'left';

/**
 * Start the upgrade of a runtime whose owner has not asked for a session since the release, with the
 * same gated Workflow a session request starts: it waits for the upgrade window and never interrupts
 * work. One that ended without upgrading is restarted: after giving up waiting for a quiet moment,
 * always; after failing, only when `restartFailed` allows it, so a lasting failure is retried at a
 * slower pace than every sweep, unless it failed after redeploying the Worker.
 */
export async function sweepUserWorkspaceRuntimeUpgrade(args: {
  env: Pick<Env, 'USER_WORKSPACE_RUNTIME_PROVISIONING'>;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  restartFailed: boolean;
  /** Whether the runtime is current after all; read again before restarting a finished Workflow. */
  isCurrent: () => Promise<boolean>;
}): Promise<UserWorkspaceRuntimeUpgradeSweepOutcome> {
  const params = provisioningParams(args);
  const id = await provisioningInstanceId(params);
  try {
    const { created } = await args.env.USER_WORKSPACE_RUNTIME_PROVISIONING.createBatch({
      instances: [{ id, params, retention: { successRetention: '1 day', errorRetention: '1 day' } }],
    });
    if (created.length > 0) {
      return 'started';
    }
  } catch {
    // As when a session request starts it: an existing id comes back as a per-instance error or a
    // throw, and either way that instance is the answer.
  }
  const instance = await args.env.USER_WORKSPACE_RUNTIME_PROVISIONING.get(id);
  const status = await instance.status();
  if (status.status === 'errored' || status.status === 'terminated' || provisioningErrorOutput(status)) {
    // One that failed after redeploying left the Worker half upgraded, so it is retried on every sweep.
    const redeployed = redeployedFailureSchema.safeParse(status.output).success;
    if (!args.restartFailed && !redeployed) {
      return 'left';
    }
    await instance.restart();
    console.warn({
      event: 'runtime_upgrade_restarted',
      reason: redeployed ? 'previous_upgrade_failed_after_redeploy' : 'previous_upgrade_failed',
    });
    return 'restarted';
  }
  if (status.status !== 'complete') {
    return 'running';
  }
  // Finished, yet the runtime was still outdated when listed: it gave up waiting for a quiet moment,
  // or it finished just since.
  if (await args.isCurrent()) {
    return 'left';
  }
  await instance.restart();
  console.info({ event: 'runtime_upgrade_restarted', reason: 'previous_upgrade_ended' });
  return 'restarted';
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
  /** `instanceId` names this upgrade to the runtime, as the holder of the window it claims. */
  event: { payload: ProvisioningParams; instanceId?: string };
  step: UserWorkspaceRuntimeProvisioningStep;
  dependencies?: UserWorkspaceRuntimeProvisioningDependencies;
}): Promise<UserWorkspaceRuntimeProvisioningResult> {
  let redeployed = false;
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
    // A runtime already serving at this endpoint is an upgrade: redeploying it resets its Durable
    // Objects, so it waits for a moment when none of them is working. One of an earlier connection
    // generation (a reconnect, which this redeploy gives a new secret) is asked with the secret it has,
    // and waited for only so long, measured from this recorded time so a replay or retry keeps it.
    const upgradeStartedAt = await args.step.do('inspect live workspace', STEP_CONFIG, async () => {
      const live = await dependencies.findRuntime(args.env.DB, params.userId, connection.id);
      return live && live.endpoint === endpoint ? dependencies.now() : null;
    });
    const secretForGeneration = (connectionGeneration: number) =>
      dependencies.deriveSecret({
        encryptionKeyBase64: args.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY,
        userId: params.userId,
        accountId: connection.accountId,
        connectionGeneration,
        organizationConnectionId: connection.orgId ? connection.id : null,
      });
    let namespaceId: string;
    let windowed = upgradeStartedAt !== null;
    for (let attempt = 0; ; attempt += 1) {
      const outcome: DeployAttempt = await args.step.do(
        `deploy workspace Worker (attempt ${attempt + 1})`,
        STEP_CONFIG,
        async () => {
          // Asked again here and before the locator is written: a member removed from their organization
          // while this ran must not get their workspace back.
          await expectedConnection(args.env, params, dependencies.requireConnection);
          let windowedAttempt = upgradeStartedAt !== null;
          if (upgradeStartedAt !== null) {
            const waitMs = await waitBeforeUpgrade({
              dependencies,
              db: args.env.DB,
              params,
              endpoint,
              controlPlaneSecret,
              secretForGeneration,
              holder: args.event.instanceId,
              attempt,
              upgradeStartedAt,
            });
            if (waitMs === 'unwindowed') {
              windowedAttempt = false;
            } else if (waitMs !== null) {
              return { status: 'busy', checkedAt: dependencies.now(), waitMs };
            }
          }
          // 'prepare workspace database' is recorded once, by the code that started the instance, but this
          // uploads the runtime of the code running now: a release deployed while it waited may need
          // migrations that step never knew. Applying is idempotent, so the runtime it uploads finds them.
          await accountApi.applyD1Migrations(databaseId, USER_WORKSPACE_DATA_MIGRATIONS);
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
          return windowedAttempt
            ? { status: 'deployed', namespaceId: deployed.namespaceId }
            : { status: 'deployed', namespaceId: deployed.namespaceId, windowed: false };
        },
      );
      if (outcome.status === 'deployed') {
        namespaceId = outcome.namespaceId;
        windowed &&= outcome.windowed !== false;
        redeployed = true;
        break;
      }
      if (upgradeStartedAt !== null && outcome.checkedAt - upgradeStartedAt >= UPGRADE_MAX_WAIT_MS) {
        console.warn({ event: 'runtime_upgrade_deferred', reason: 'workspace_never_idle', attempts: attempt + 1 });
        return { status: 'deferred' };
      }
      await args.step.sleep(`wait for an idle workspace (attempt ${attempt + 1})`, outcome.waitMs);
    }
    // An upgrade keeps its window open on the runtime it just deployed until that runtime serves on the new
    // container image: the rollout replaces running containers at once, so work that started meanwhile
    // would be cut off, and the new Worker would talk to the old image. A first workspace has no window.
    const window = {
      endpoint,
      controlPlaneSecret,
      targetVersion: USER_WORKSPACE_RUNTIME_SHA256,
      holder: args.event.instanceId,
    };
    /**
     * One step after the redeploy, run with the window held. A retry's backoff can outlast the window,
     * and the runtime opens a lapsed window again only while nothing started meanwhile: when something
     * did, the step waits for it like a busy workspace before the redeploy, never redeploying again and
     * never giving up, since the Worker it deployed is already serving. `prepare` runs first, outside
     * the window, for what renewing the window itself needs.
     */
    const heldStep = async (
      name: string,
      config: typeof STEP_CONFIG | typeof LONG_STEP_CONFIG,
      operation: () => Promise<void>,
      prepare: () => Promise<void> = async () => undefined,
    ): Promise<void> => {
      if (!windowed) {
        await args.step.do(name, config, async () => {
          await prepare();
          await operation();
        });
        return;
      }
      for (let attempt = 0; ; attempt += 1) {
        // The first attempt keeps the step's name, so a Workflow started before these waits replays it.
        const outcome = await args.step.do<HeldStepAttempt>(
          attempt === 0 ? name : `${name} (attempt ${attempt + 1})`,
          config,
          async () => {
            await prepare();
            try {
              await whileHoldingUpgradeWindow(dependencies, window, operation);
            } catch (error) {
              if (!(error instanceof RuntimeUpgradeWindowRefusedError)) {
                throw error;
              }
              console.info({ event: 'runtime_upgrade_waiting', reason: 'work_started_after_window', busy: error.busy });
              return { status: 'busy', checkedAt: dependencies.now(), waitMs: upgradeWaitMs(attempt) };
            }
            return { status: 'done' };
          },
        );
        if (outcome?.status !== 'busy') {
          return;
        }
        await args.step.sleep(`wait for an idle workspace to ${name} (attempt ${attempt + 1})`, outcome.waitMs);
      }
    };
    // Their own steps after the deploy, so retrying them never claims the window again or redeploys. The
    // Worker's subdomain, through which the window is renewed, is enabled before the window is held.
    await heldStep(
      'configure workspace Worker',
      STEP_CONFIG,
      async () => {
        await accountApi.configureWorkspaceRuntimeGcSchedule(workerName);
      },
      async () => {
        await accountApi.enableWorkerSubdomain(workerName);
      },
    );
    await heldStep('deploy Sandbox container', LONG_STEP_CONFIG, async () => {
      await accountApi.ensureWorkspaceRuntimeContainer({
        applicationName: workerName,
        namespaceId,
        image: USER_WORKSPACE_SANDBOX_BASE_IMAGE,
      });
    });
    await heldStep('wait for workspace', LONG_STEP_CONFIG, async () => {
      await dependencies.waitForReadiness({
        endpoint,
        controlPlaneSecret,
        runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
        request: fetch,
      });
    });
    if (windowed) {
      await args.step.do('release upgrade window', STEP_CONFIG, async () => {
        // The window lapses on its own shortly; failing to close it early only delays waiting work.
        await dependencies.changeUpgradeWindow({ ...window, change: 'release' }).catch(() => {
          console.warn({ event: 'runtime_upgrade_window_release_failed' });
        });
      });
    }
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
    return redeployed
      ? { status: 'error', errorCode: 'workspace_preparation_failed', upgradeUrl: null, redeployed: true }
      : { status: 'error', errorCode: 'workspace_preparation_failed', upgradeUrl: null };
  }
}

/**
 * How long to wait before trying to upgrade a live workspace again, or null to upgrade it now. A
 * runtime that reports its activity is asked for the upgrade window, granted only while nothing in it
 * runs; one too old to report it is upgraded once no session was issued for it for longer than any
 * turn runs. One of an earlier connection generation is asked with that generation's secret, then
 * with this one's (a retry may find the Worker this upgrade already redeployed); `unwindowed` is one
 * that refused both, which can only be redeployed as a first workspace is, or one still busy
 * `EARLIER_GENERATION_MAX_WAIT_MS` after the upgrade started, whose member it would otherwise lock out.
 */
async function waitBeforeUpgrade(args: {
  dependencies: UserWorkspaceRuntimeProvisioningDependencies;
  db: D1Database;
  params: ProvisioningParams;
  endpoint: string;
  controlPlaneSecret: string;
  secretForGeneration: (connectionGeneration: number) => Promise<string>;
  holder: string | undefined;
  attempt: number;
  upgradeStartedAt: number;
}): Promise<number | null | 'unwindowed'> {
  const live = await args.dependencies.findRuntime(args.db, args.params.userId, args.params.connectionId);
  const claim = (controlPlaneSecret: string) =>
    args.dependencies.claimUpgradeWindow({
      endpoint: args.endpoint,
      controlPlaneSecret,
      targetVersion: USER_WORKSPACE_RUNTIME_SHA256,
      holder: args.holder,
    });
  const claimWithEitherSecret = async (earlierSecret: string) => {
    for (const secret of [earlierSecret, args.controlPlaneSecret]) {
      try {
        return await claim(secret);
      } catch (error) {
        if (!(error instanceof RuntimeSecretRefusedError)) {
          throw error;
        }
      }
    }
    return null;
  };
  const earlierGeneration = live !== null && live.connectionGeneration !== args.params.connectionGeneration;
  const window = earlierGeneration
    ? await claimWithEitherSecret(await args.secretForGeneration(live.connectionGeneration))
    : await claim(args.controlPlaneSecret);
  if (!window) {
    console.warn({ event: 'runtime_upgrade_unwindowed', reason: 'earlier_generation_refused_secret' });
    return 'unwindowed';
  }
  if (window.status === 'granted') {
    return null;
  }
  let waitMs: number;
  if (window.status === 'busy') {
    waitMs = upgradeWaitMs(args.attempt);
  } else {
    const quietFor = args.dependencies.now() - (live?.lastSessionAt ?? 0);
    if (quietFor >= LEGACY_RUNTIME_QUIET_MS) {
      return null;
    }
    waitMs = Math.min(LEGACY_RUNTIME_QUIET_MS - quietFor, LEGACY_RUNTIME_LONGEST_WAIT_MS);
  }
  const reason = window.status === 'busy' ? 'workspace_busy' : 'legacy_runtime_recently_used';
  const busy = window.status === 'busy' ? window.busy : undefined;
  if (earlierGeneration) {
    // Its member has no session meanwhile, so nothing they can do ends the wait: past the cap the
    // reconnect's redeploy goes ahead, ending whatever still runs, rather than lock them out for hours.
    const waitedMs = args.dependencies.now() - args.upgradeStartedAt;
    if (waitedMs >= EARLIER_GENERATION_MAX_WAIT_MS) {
      console.warn({ event: 'runtime_upgrade_unwindowed', reason: 'earlier_generation_wait_capped', waitedMs, busy });
      return 'unwindowed';
    }
    waitMs = Math.min(waitMs, EARLIER_GENERATION_MAX_WAIT_MS - waitedMs);
  }
  console.info({ event: 'runtime_upgrade_waiting', reason, busy });
  return waitMs;
}

/** How long to wait before asking a busy workspace again: doubling from the first wait, up to the longest. */
function upgradeWaitMs(attempt: number): number {
  return Math.min(UPGRADE_FIRST_WAIT_MS * 2 ** Math.min(attempt, 10), UPGRADE_LONGEST_WAIT_MS);
}

/**
 * Run one upgrade step with its window held: renewed first, which fails the step when the new runtime
 * cannot be asked, then every `UPGRADE_WINDOW_RENEWAL_MS` until the step settles. A renewal that fails
 * midway is logged; the window then lapses at worst, never blocking work forever.
 */
async function whileHoldingUpgradeWindow<T>(
  dependencies: Pick<UserWorkspaceRuntimeProvisioningDependencies, 'changeUpgradeWindow' | 'sleep'>,
  window: { endpoint: string; controlPlaneSecret: string; targetVersion: string; holder: string | undefined },
  operation: () => Promise<T>,
): Promise<T> {
  // Refused (thrown) when the window lapsed while work started, before anything runs.
  await dependencies.changeUpgradeWindow({ ...window, change: 'hold' });
  let stop: () => void = () => undefined;
  const stopped = new Promise<boolean>((resolve) => {
    stop = () => resolve(false);
  });
  const renewals = (async () => {
    while (await Promise.race([dependencies.sleep(UPGRADE_WINDOW_RENEWAL_MS).then(() => true), stopped])) {
      await dependencies.changeUpgradeWindow({ ...window, change: 'hold' }).catch(() => {
        console.warn({ event: 'runtime_upgrade_window_renewal_failed' });
      });
    }
  })();
  try {
    return await operation();
  } finally {
    stop();
    await renewals;
  }
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
