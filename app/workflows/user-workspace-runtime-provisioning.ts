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
import { upsertUserWorkspaceRuntime } from '~/lib/.server/cloudflare/user-workspace-runtime-repository';
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

export type UserWorkspaceRuntimeProvisioningResult = { status: 'ready' } | ProvisioningError;
export type UserWorkspaceRuntimeProvisioningLaunchResult = { status: 'preparing' } | ProvisioningError;

const STEP_CONFIG = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} as const;
const LONG_STEP_CONFIG = {
  retries: { limit: 7, delay: '15 seconds', backoff: 'exponential' },
  timeout: '30 minutes',
} as const;

export type UserWorkspaceRuntimeProvisioningStep = {
  do<T>(name: string, config: typeof STEP_CONFIG | typeof LONG_STEP_CONFIG, operation: () => Promise<T>): Promise<T>;
};

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
};

const provisioningDependencies: UserWorkspaceRuntimeProvisioningDependencies = {
  requireConnection: requireActiveCloudflareConnection,
  resolveCredential: (env, handle) => D1CloudflareCredentialVault.fromEnv(env).resolve(handle),
  createAccountApi: (accountId, accessToken) => new UserCloudflareAccountApi(accountId, accessToken),
  deriveSecret: deriveUserWorkspaceRuntimeSecret,
  waitForReadiness: waitForUserWorkspaceRuntimeReadiness,
  upsertRuntime: upsertUserWorkspaceRuntime,
};

/** Start or inspect the one durable Workflow for this connection and runtime build. */
export async function startUserWorkspaceRuntimeProvisioning(args: {
  env: Pick<Env, 'USER_WORKSPACE_RUNTIME_PROVISIONING'>;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  retry?: boolean;
}): Promise<UserWorkspaceRuntimeProvisioningLaunchResult> {
  const params: ProvisioningParams = {
    userId: args.userId,
    connectionId: args.connectionId,
    connectionGeneration: args.connectionGeneration,
  };
  const id = `workspace-${await sha256Hex(
    `${params.connectionId}\0${params.connectionGeneration}\0${USER_WORKSPACE_RUNTIME_SHA256}\0${USER_WORKSPACE_SANDBOX_BASE_IMAGE}`,
  )}`;
  try {
    await args.env.USER_WORKSPACE_RUNTIME_PROVISIONING.createBatch([
      { id, params, retention: { successRetention: '1 day', errorRetention: '1 day' } },
    ]);
    return { status: 'preparing' };
  } catch {
    // The binding throws rather than returning an empty batch when the id already exists, which is
    // the ordinary case on every poll after the first for this connection generation and runtime
    // build. Inspecting the existing instance is the answer, not a preparation failure.
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
    const suffix = (await sha256Hex(`${connection.accountId}:${params.userId}`)).slice(0, 16);
    const workerName = `ghostbuild-workspace-${suffix}`;
    const databaseName = `ghostbuild-data-${suffix}`;

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
    });
    const databaseId = await args.step.do('prepare workspace database', STEP_CONFIG, async () => {
      const database = await accountApi.ensureD1Database(databaseName);
      await accountApi.applyD1Migrations(database.id, USER_WORKSPACE_DATA_MIGRATIONS);
      return database.id;
    });
    const namespaceId = await args.step.do('deploy workspace Worker', STEP_CONFIG, async () => {
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
      });
      await Promise.all([
        accountApi.configureWorkspaceRuntimeGcSchedule(workerName),
        accountApi.enableWorkerSubdomain(workerName),
      ]);
      return deployed.namespaceId;
    });
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
    await args.step.do('mark workspace ready', STEP_CONFIG, () =>
      dependencies.upsertRuntime({
        db: args.env.DB,
        userId: params.userId,
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        workerName,
        endpoint,
        runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
        imageDigest: USER_WORKSPACE_SANDBOX_BASE_IMAGE,
      }),
    );
    return { status: 'ready' };
  } catch (error) {
    // Only the message is logged: the thrown messages on this path are fixed, while the error
    // object can carry a `cause` from parsing a decrypted credential, which must not reach a log.
    console.error('Workspace runtime provisioning failed', error instanceof Error ? error.message : 'Unknown error');
    return { status: 'error', errorCode: 'workspace_preparation_failed', upgradeUrl: null };
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
    connection.userId !== params.userId ||
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
