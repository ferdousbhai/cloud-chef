import type { WorkspaceRuntimeExecHandle } from '@cloudflare/computer';
import {
  getWorkspace,
  type WorkspaceClient,
  type WorkspaceRuntimeResult,
  Workspace,
  WorkspaceProxy,
} from '@cloudflare/computer';
import { type SandboxCommand } from '@cloudflare/sandbox';
import { parse } from 'jsonc-parser';
import { settleCancelledWorkspaceCommand } from './command-cancellation';
import { terminateWorkspaceCommand } from './command-termination';
import {
  isExecutionReattachable,
  reattachExecution,
  WORKSPACE_RESTART_INDETERMINATE_MESSAGE,
} from './execution-reattach';
import { BuilderAgent } from '../../app/agents/builder-agent';
import { COMPUTER_TOOL_LIMITS } from '../../ghostbuild-agent/cloudflare-computer';
import {
  type BuilderWorkspaceState as WorkspaceState,
  BUILDER_WORKSPACE_MAX_FILE_BYTES,
  BUILDER_WORKSPACE_MAX_FILES,
  BUILDER_WORKSPACE_MAX_TOTAL_BYTES,
  BUILDER_WORKSPACE_SYNC_BATCH_BYTES,
  BUILDER_WORKSPACE_SYNC_BATCH_FILES,
} from './protocol';
import { routeUserRuntimeAgentRequest } from '../../app/lib/.server/agent-request-identity';
import {
  createTrustedDeploymentConfig,
  type DeploymentConfigInput,
} from '../../app/lib/.server/cloudflare/deployment-config';
import { recordDeploymentActivity } from '../../app/lib/.server/cloudflare/deployment-repository';
import type { BuilderValidationStage } from '../../app/lib/common/builder-validation-progress';
import type { WorkspaceValidationStageReporter } from '../../app/agents/builder-workspace-api';
import { deploymentProjectProfileFromConfig } from '../../app/lib/.server/cloudflare/deployment-project-profile';
import type { DeploymentProjectProfile } from '../../app/lib/.server/cloudflare/deployment-project-profile';
import { DEPLOYMENT_PROJECT_ROOT } from '../../app/lib/.server/cloudflare/deployment-runtime-policy';
import {
  MAX_DEPLOYMENT_ARTIFACT_BYTES,
  MAX_DEPLOYMENT_ARTIFACT_FILES,
  preparedDeploymentArtifactDigest,
  type DeploymentArtifactFile,
  type PreparedDeploymentArtifact,
  validatePreparedDeploymentArtifact,
} from '../../app/lib/.server/cloudflare/deployment-artifact';
import { addRequestedDependencies } from '../../app/lib/runtime/action-runner/dependency-manifest';
import { userRuntimeDataAction, userRuntimeInitialMessagesAction } from '../../app/lib/cloudflare/data.server';
import { verifyRuntimeCapability } from '../../app/lib/cloudflare/runtime-capability';
import { userRuntimeDeploymentAction } from '../../app/server-handlers/deployments';
import { userRuntimeEnhancePromptAction } from '../../app/server-handlers/enhance-prompt';
import {
  readWorkersAiBuilderModelCatalog,
  workersAiModelCatalogPayload,
} from '../../app/lib/.server/llm/workers-ai-model-catalog';
import {
  isGhostbuildToolResult,
  toolFailure,
  toolSuccess,
  type GhostbuildToolResult,
} from '../../ghostbuild-agent/tool-result';
import { rejectedWorkspaceCommand } from '../../ghostbuild-agent/workspace-boundary';
import { applyAtomicWorkspaceChanges, type AtomicWorkspaceChange } from './atomic-workspace-changes';
import { ComputerAdmissionControl } from './computer-admission';
import { isComputerContainerCallback } from './container-fetch-routing';
import { CONTAINER_PNPM_STORE_DIR } from './container-toolchain';
import { routeUserWorkspaceRuntimeControlPlaneRequest } from './readiness-route';
import { scheduleUserWorkspaceRuntimeMaintenance } from './scheduled-maintenance';
import {
  ToolOperationJournal,
  type ToolOperationCancellationResult,
  type ToolOperationStartResult,
} from './tool-operation-journal';
import { createCommittedMutationReceipt, type MutationReceiptFileInput } from './mutation-receipt';
import {
  WorkspaceOperationConflictError,
  WorkspaceOperationIndeterminateError,
  WorkspaceOperationLane,
  type WorkspaceOperationLease,
} from './workspace-operation-lane';
import { OperationLeaseHeartbeat, type OperationLiveness } from './operation-lease-heartbeat';
import {
  CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS,
  OPERATION_LEASE_MS,
  OPERATION_TOOL_BUDGET_MS,
  operationLeasePlan,
  type StatefulOperationKind,
} from './operation-lease-policy';
import {
  DurableWorkspaceSyncRetryScheduler,
  requireDurableCommandResult,
  requireWorkspaceSyncBarrier,
  WorkspaceSyncPendingError,
} from './workspace-sync-retry';
import {
  MATERIALIZATION_CONCURRENCY,
  forEachConcurrently,
  isolatedTargetPath,
  requiredDirectories,
} from './isolated-materialization';
import { shellQuote } from './shell-quote';
import { first } from './sql-rows';
import { stableWorkspaceRead } from './stable-workspace-read';
import {
  isolatedContentDigestCommand,
  projectContentDigest,
  projectContentDigestInput,
} from './workspace-content-digest';
import { parallelStagesTimeoutMs, parallelValidationStagesCommand } from './validation-stages';
import {
  enumerateProjectEntries,
  requireProjectListingOptions,
  requireProjectSearchOptions,
  scanProjectFiles,
  type DiscoveryScope,
} from './workspace-discovery';
import { requireDeploymentMigrationName, requireWorkspaceFileEncoding } from './workspace-input';
import { withCors } from './http-cors';
import {
  runTrackedSandboxCommand,
  SandboxProcessTerminationUnconfirmedError,
  terminateTrackedSandboxProcess,
  type TrackedSandboxProcess,
} from './tracked-command';
import { ValidationCancellation } from './validation-cancellation';
import { COMPUTERD_ENV, COMPUTERD_PROCESS_ROLE, ComputerSandboxBase } from './computer-sandbox';
import {
  createContainerDirectoryCommand,
  ISOLATED_PROJECT_ROOT,
  rebaseDeploymentConfigPaths,
  relativeIsolatedPath,
} from './isolated-project';

export { WorkspaceProxy };

interface RuntimeEnv {
  PROJECT_WORKSPACE: DurableObjectNamespace<ProjectWorkspace>;
  BuilderAgent: DurableObjectNamespace<BuilderAgent>;
  DB: D1Database;
  AI: Ai;
  CONTROL_PLANE_SECRET: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  GHOSTBUILD_USER_ID: string;
  GHOSTBUILD_CONNECTION_ID: string;
  GHOSTBUILD_CONNECTION_GENERATION: string;
  GHOSTBUILD_OAUTH_SCOPE_GRANT_STATUS: string;
  GHOSTBUILD_USER_RUNTIME: string;
  GHOSTBUILD_CONTROL_PLANE_ENDPOINT: string;
  GHOSTBUILD_RUNTIME_VERSION: string;
}

/** Payload carried by the Durable Object alarms this class schedules for itself. */
interface ScheduledRetryPayload {
  notBefore: number;
  backend?: string;
  attempt?: number;
}

const PROJECT_ROOT = DEPLOYMENT_PROJECT_ROOT;
const READINESS_ROOT = '/home/.ghostbuild-readiness';
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = BUILDER_WORKSPACE_MAX_FILE_BYTES;
const MAX_TOTAL_BYTES = BUILDER_WORKSPACE_MAX_TOTAL_BYTES;
const MAX_FILES = BUILDER_WORKSPACE_MAX_FILES;
const SYNC_BATCH_BYTES = BUILDER_WORKSPACE_SYNC_BATCH_BYTES;
const SYNC_BATCH_FILES = BUILDER_WORKSPACE_SYNC_BATCH_FILES;
const CHECKPOINT_EXCLUDED_ROOTS = new Set(['node_modules', 'dist', '.output', '.tanstack', '.wrangler']);
/**
 * `--store-dir` points every install at the store the workspace image pre-warms, which is what
 * turns a from-scratch dependency install into a hardlink pass. `--prefer-offline` keeps a warm
 * store from paying registry round-trips it does not need; anything the store is missing is still
 * fetched normally, so a project whose lockfile has moved past the image installs correctly.
 */
const INSTALL_COMMAND =
  'pnpm install --frozen-lockfile --ignore-scripts=true --ignore-pnpmfile --prefer-offline ' +
  `--store-dir ${CONTAINER_PNPM_STORE_DIR} --registry=https://registry.npmjs.org/`;
const INSTALL_TIMEOUT_MS = CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS;
const WEB_APP_BUNDLE_SCRIPT = [
  "import { createRequire } from 'node:module';",
  "const require = createRequire(import.meta.resolve('vite'));",
  "const { build } = require('esbuild');",
  "await build({ entryPoints: [process.argv[1]], bundle: true, minify: true, format: 'esm', platform: 'node', external: ['cloudflare:*'], outfile: process.argv[2] });",
].join('');
const PREPARED_VALIDATION_ROOT = `${ISOLATED_PROJECT_ROOT}/validated-artifact`;
const PREPARED_VALIDATION_CONFIG = `${PREPARED_VALIDATION_ROOT}/.ghostbuild-deploy.json`;
const PREPARED_VALIDATION_ARTIFACT_ROOT = `${PREPARED_VALIDATION_ROOT}/.ghostbuild-artifact`;
/**
 * Per-stage validation ceilings. These run through the native Sandbox exec
 * path (`runTransientCommand`), where `timeout` is a remote process-lifetime
 * deadline — the container supervisor ends the process and reports
 * `timedOut: true` — plus a local observation bound in `tracked-command.ts`.
 * A real total-runtime cap, unlike the container-shell `timeoutMs` hint
 * documented at `EXEC_COMMAND_TIMEOUT_MS` (#128).
 */
/**
 * `pnpm run typecheck` runs `tsr generate` and `wrangler types` before `tsc`, so the route tree
 * and binding declarations it writes are inputs to lint and to the production build. It is the one
 * validation stage that has to finish before the others start.
 */
const REVISION_CODEGEN_COMMAND = { command: 'pnpm run typecheck', timeoutMs: 5 * 60_000 } as const;
const PARALLEL_VALIDATION_STAGES = [
  { name: 'verify_stack', command: 'pnpm run verify:stack', timeoutMs: 5 * 60_000 },
  { name: 'lint', command: 'pnpm run lint', timeoutMs: 5 * 60_000 },
] as const;
const VALIDATION_STAGE_LOG_ROOT = `${ISOLATED_PROJECT_ROOT}/validation-stage-logs`;
/**
 * Validation and deployment share `buildDeploymentArtifact`, so they share its activity sequence.
 * Deployment records those numbers durably; validation translates them into the stage the UI shows.
 */
const BUILD_ARTIFACT_STAGES = new Map<number, BuilderValidationStage>([
  [33, 'build'],
  [34, 'packaging'],
  [35, 'packaging'],
  [36, 'finalizing'],
]);
/**
 * `timeoutMs` for a container-shell exec is a process-lifetime hint shipped to
 * computerd over Computer's shell RPC. @cloudflare/computer 0.2.1 enforces a
 * `timeoutMs` timer only in its worker-shell backend; for `container-shell`
 * it is forwarded with no client-side backstop, and computerd demonstrably
 * does not enforce it either — a validation command ran 9m23s under a
 * five-minute value and was ended by its lease, not this (#128). The bounds
 * that actually govern tool exec are the tool budget above the lane and the
 * renewed operation lease, so this hint is derived from that same budget: if
 * a future computerd starts honoring it as the total-runtime deadline its
 * schema describes, it cannot disagree with the layer above (#127).
 */
const EXEC_COMMAND_TIMEOUT_MS = OPERATION_TOOL_BUDGET_MS.exec;
const TRANSIENT_COMMAND_PROCESS_ROLE = 'transient-command';
const VALIDATION_CANCELLATION_SETTLE_MS = 45_000;
const CONTAINER_RECOVERY_TIMEOUT_MS = 60_000;

/**
 * Consecutive failed exhausted-sync recoveries before the container itself is recycled. A pull
 * that keeps failing after Computer exhausted its own retry budget and a fresh backend handle
 * was tried is the signature of a container whose control connection never comes back - each
 * attempt burns the vendor's connect retries (observed as exactly ~180s per recovery round in
 * production) and no number of further pulls converges. Sync recovery escalates by replacing the
 * ephemeral container while preserving the durable workspace.
 */
const SYNC_RECOVERY_CONTAINER_RECYCLE_THRESHOLD = 2;

/** Reported progress is only read by a heartbeat, and lanes nobody renews have none. */
const UNWATCHED_OPERATION_LIVENESS: OperationLiveness = { observed: () => undefined };

type ActiveValidation = {
  toolCallId: string;
  inputJson: string;
  cancellation: ValidationCancellation;
  promise: Promise<GhostbuildToolResult>;
};

type WorkspaceFile = {
  path: string;
  bytes: Uint8Array;
  size: number;
  mode: number;
  sha256: string;
};

type PreparedValidationRow = {
  revision: string;
  workspace_revision: number;
  snapshot_root: string;
  artifact_digest: string | null;
};

type DeploymentSessionRow = {
  operation_id: string;
  owner: string;
  idempotency_key: string;
  expected_workspace_revision: number;
  expected_snapshot_revision: string;
  acquired_at: number;
  deadline: number;
  status: 'active' | 'completed' | 'failed' | 'indeterminate';
};

export class ProjectWorkspace extends ComputerSandboxBase<RuntimeEnv> {
  #workspace: Workspace;
  readonly #toolOperations: ToolOperationJournal;
  readonly #operationLane: WorkspaceOperationLane;
  readonly #syncRetries: DurableWorkspaceSyncRetryScheduler;
  readonly #admission: ComputerAdmissionControl;
  readonly #activeOperationOwners = new Set<string>();
  #activeValidation: ActiveValidation | null = null;
  /**
   * The computerd generation whose `/home/project` view has been proved to match durable truth.
   * In memory on purpose: a Durable Object restart re-verifies, which errs toward checking again.
   */
  #verifiedContainerGeneration: string | null = null;
  readonly #activeSyncRecoveries = new Map<string, Promise<boolean>>();
  /** Consecutive failed exhausted-sync recoveries per backend; in-memory, reset on success. */
  readonly #syncRecoveryFailures = new Map<string, number>();
  readonly #activeToolOperations = new Set<string>();
  readonly #ownedToolOperations = new Set<string>();
  readonly #confirmedCommandCancellations = new Set<string>();
  readonly #activeCommandKills = new Map<string, () => Promise<void>>();
  readonly #activeCommandStreams = new Set<string>();
  readonly #activeCommandSettlements = new Map<string, Promise<unknown>>();
  readonly #pendingCommandCancellations = new Set<string>();
  #containerKeepAliveOperations = 0;

  constructor(ctx: DurableObjectState<{}>, env: RuntimeEnv) {
    super(ctx, env);
    this.#syncRetries = new DurableWorkspaceSyncRetryScheduler(ctx.storage, async (intent) => {
      await this.scheduleOnce(
        Math.max(0, Math.ceil((intent.notBefore - Date.now()) / 1_000)),
        'retryPendingComputerSync',
        {
          backend: intent.backend,
          attempt: intent.attempt,
          notBefore: intent.notBefore,
        },
      );
    });
    this.#syncRetries.initialize();
    this.ctx.waitUntil(
      this.#syncRetries
        .reconcile()
        .catch((error) => console.error('Unable to reconcile persisted Computer sync retries', error)),
    );
    this.#admission = new ComputerAdmissionControl(env.DB);
    this.#workspace = new Workspace(this.createComputerWorkspaceOptions(this.#syncRetries));
    this.#toolOperations = new ToolOperationJournal(ctx.storage);
    this.#toolOperations.initialize();
    if (this.#toolOperations.pending().length > 0 || this.#syncRetries.state('container-shell')?.exhausted === true) {
      this.ctx.waitUntil(this.reconcilePendingCommands());
    }
    this.#operationLane = new WorkspaceOperationLane(
      ctx.storage,
      (owner) => this.#activeOperationOwners.has(owner),
      (kind) => kind === 'validate',
    );
    this.#operationLane.initialize();
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_sandbox_processes (
         role TEXT PRIMARY KEY,
         process_id TEXT NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_workspace_state (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         initialized INTEGER NOT NULL DEFAULT 0,
         seed_id TEXT,
         reset_revision INTEGER NOT NULL DEFAULT 0
       )`,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO ghostbuild_workspace_state (singleton, initialized, reset_revision)
       VALUES (1, 0, 0)`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_validations (
         revision TEXT PRIMARY KEY,
         workspace_revision INTEGER NOT NULL,
         validated_at INTEGER NOT NULL
      )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_prepared_validation (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         revision TEXT NOT NULL,
         workspace_revision INTEGER NOT NULL,
         snapshot_root TEXT NOT NULL,
         artifact_digest TEXT
       )`,
    );
    const preparedColumns = [
      ...this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(ghostbuild_prepared_validation)'),
    ];
    if (!preparedColumns.some((column) => column.name === 'artifact_digest')) {
      this.ctx.storage.sql.exec('ALTER TABLE ghostbuild_prepared_validation ADD COLUMN artifact_digest TEXT');
    }
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_workspace_identity (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         project_id TEXT NOT NULL,
         user_id TEXT NOT NULL,
         initialized_at INTEGER NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_deployment_sessions (
         operation_id TEXT PRIMARY KEY,
         owner TEXT NOT NULL,
         idempotency_key TEXT NOT NULL UNIQUE,
         expected_workspace_revision INTEGER NOT NULL,
         expected_snapshot_revision TEXT NOT NULL,
         acquired_at INTEGER NOT NULL,
         deadline INTEGER NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'indeterminate')),
         updated_at INTEGER NOT NULL
       )`,
    );
    // Runtime schema migration: previews are now immutable Worker versions in the user's account,
    // so no process, tunnel, cancellation, or expiry state belongs in this container Durable Object.
    for (const table of [
      'ghostbuild_active_preview',
      'ghostbuild_pending_previews',
      'ghostbuild_preview_results',
      'ghostbuild_preview_cancellations',
    ]) {
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  }

  override fetch(request: Request): Promise<Response> {
    if (isComputerContainerCallback(request)) {
      return this.containerBackend.handleFetch(request);
    }
    return super.fetch(request);
  }

  async __getWorkspaceStub() {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  initializeProjectIdentity(value: unknown): void {
    const input = record(value);
    const projectId = requireString(input.projectId, 'projectId', 256);
    const userId = requireString(input.userId, 'userId', 256);
    if (userId !== this.env.GHOSTBUILD_USER_ID) {
      throw new Error('ProjectWorkspace user isolation check failed.');
    }
    this.ctx.storage.transactionSync(() => {
      const existing = first(
        this.ctx.storage.sql.exec<{ project_id: string; user_id: string }>(
          `SELECT project_id, user_id FROM ghostbuild_workspace_identity WHERE singleton = 1`,
        ),
      );
      if (existing && (existing.project_id !== projectId || existing.user_id !== userId)) {
        throw new Error('ProjectWorkspace identity does not match its durable owner.');
      }
      if (!existing) {
        this.ctx.storage.sql.exec(
          `INSERT INTO ghostbuild_workspace_identity (singleton, project_id, user_id, initialized_at)
           VALUES (1, ?, ?, ?)`,
          projectId,
          userId,
          Date.now(),
        );
      }
    });
  }

  async retryPendingComputerSync(value: unknown): Promise<void> {
    const backend = requireBackend(record(value).backend);
    const state = this.#syncRetries.state(backend);
    if (!state) {
      return;
    }
    if (state.exhausted) {
      const recovered = await this.recoverExhaustedComputerSync(backend);
      if (!recovered) {
        await this.schedulePendingCommandRecovery(60_000);
      }
      console.info('ProjectWorkspace Computer sync retry is exhausted', {
        backend,
        attempt: state.attempt,
        ageMs: Math.max(0, Date.now() - state.createdAt),
        exhaustion: true,
        recovery: recovered ? 'complete' : 'pending',
      });
      return;
    }
    const now = Date.now();
    if (state.notBefore > now) {
      await this.#syncRetries.rearm(backend);
      return;
    }
    const result = await this.#workspace.retryPendingSync(backend);
    const event = {
      backend,
      attempt: state.attempt,
      ageMs: Math.max(0, now - state.createdAt),
      cause: state.lastError ? 'post_command_pull_failed' : 'post_command_pull_pending',
      completion: result.status,
      exhaustion: result.status === 'exhausted',
    };
    if (result.status === 'pending' || result.status === 'exhausted') {
      this.#syncRetries.recordFailure(backend, result.error, result.status === 'exhausted');
    }
    if (result.status === 'complete' || result.status === 'idle') {
      this.finishPendingCommand(backend);
      await this.cleanupReadinessRoot().catch(() => undefined);
    } else if (result.status === 'lost') {
      // The runtime that ran the command is gone, so its output can never be pulled and the durable
      // VFS never received those mutations. Completing the continuation here would report a command
      // that did not land as durably synced, so it terminalizes as a failure instead. Computer has
      // already cleared its intent; failing the journal row stops the continuation from being
      // finished by reconcilePendingCommands' "no retry row" pull.
      this.failPendingCommand(
        backend,
        `The workspace command cannot be confirmed: the container that ran it is gone (${result.error}).`,
      );
      await this.cleanupReadinessRoot().catch(() => undefined);
    } else if (result.status === 'exhausted') {
      const recovered = await this.recoverExhaustedComputerSync(backend);
      if (!recovered) {
        await this.schedulePendingCommandRecovery(60_000);
      }
    }
    console.info('ProjectWorkspace Computer sync retry', event);
  }

  /**
   * A command continuation owns its own recovery wake. Computer clears its
   * retry intent before returning a successful retry, so its scheduler row
   * cannot be the only durable evidence that the original tool still needs
   * terminalization.
   */
  async reconcilePendingCommands(): Promise<void> {
    let retryAt = Number.POSITIVE_INFINITY;
    const pending = this.#toolOperations.pending();
    const backends = new Set(pending.map((continuation) => continuation.backend));
    if (this.#syncRetries.state('container-shell')?.exhausted) {
      backends.add('container-shell');
    }
    for (const backend of backends) {
      const state = this.#syncRetries.state(backend);
      try {
        if (state) {
          if (state.exhausted) {
            if (!(await this.recoverExhaustedComputerSync(backend))) {
              retryAt = Math.min(retryAt, Date.now() + 60_000);
            }
            continue;
          }
          if (state.notBefore > Date.now()) {
            retryAt = Math.min(retryAt, state.notBefore);
            continue;
          }
          await this.retryPendingComputerSync({ backend });
          const retry = this.#syncRetries.state(backend);
          if (retry) {
            retryAt = Math.min(retryAt, retry.exhausted ? Date.now() + 60_000 : retry.notBefore);
          }
        } else {
          // Absence of Computer's retry row is not proof of success: the
          // package intentionally swallows host scheduling failures after a
          // command. An ordinary pull is idempotent and proves remote changes
          // reached the durable VFS before the tool result is exposed.
          await this.#workspace.pull(backend);
          this.finishPendingCommand(backend);
          await this.cleanupReadinessRoot().catch(() => undefined);
        }
      } catch {
        retryAt = Math.min(retryAt, Date.now() + 1_000);
      }
    }
    if (this.#toolOperations.pending().length > 0 || this.#syncRetries.state('container-shell')?.exhausted === true) {
      await this.schedulePendingCommandRecovery(Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 1_000);
    }
  }

  async beginToolOperation(value: unknown): Promise<ToolOperationStartResult | { status: 'reattach' }> {
    await this.#admission.admitNewOperation();
    this.requireCompletedComputerSync();
    const input = record(value);
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    const toolName = requireRemoteToolName(input.toolName);
    const argsJson = requireString(input.argsJson, 'argsJson', MAX_REQUEST_BYTES);
    const started = this.#toolOperations.begin({
      toolCallId,
      toolName,
      argsSha256: await sha256Text(argsJson),
    });
    if (started.status === 'execute') {
      this.#ownedToolOperations.add(toolCallId);
    }
    if (
      started.status === 'indeterminate' &&
      (this.#activeToolOperations.has(toolCallId) ||
        this.#activeCommandStreams.has(`tool:${toolCallId}`) ||
        this.#toolOperations.pending().some((operation) => operation.toolCallId === toolCallId))
    ) {
      return { status: 'active' };
    }
    if (started.status === 'indeterminate' && this.#toolOperations.interrupted(toolCallId)?.toolName === 'exec') {
      // A command runs in the container, which survives the Durable Object reset a code update
      // causes. The answer is only lost if the execution itself can no longer be observed.
      return (await this.canReattachToolExecution(toolCallId))
        ? { status: 'reattach' }
        : { status: 'indeterminate', error: WORKSPACE_RESTART_INDETERMINATE_MESSAGE };
    }
    return started;
  }

  completeToolOperation(value: unknown): unknown {
    const input = record(value);
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    const toolName = this.#toolOperations.toolName(toolCallId);
    if (toolName === 'write' || toolName === 'edit') {
      const receipt = this.#toolOperations.mutationReceipt(toolCallId);
      if (receipt) {
        const result = this.#toolOperations.acknowledgeMutation({ toolCallId, result: input.result });
        this.#ownedToolOperations.delete(toolCallId);
        return result;
      }
    }
    const result = this.#toolOperations.complete({
      toolCallId,
      result: input.result,
    });
    this.#ownedToolOperations.delete(toolCallId);
    return result;
  }

  failToolOperation(value: unknown): void {
    const input = record(value);
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    this.#toolOperations.fail({
      toolCallId,
      error: requireString(input.error, 'error', 4_000),
    });
    this.#ownedToolOperations.delete(toolCallId);
  }

  cancelToolOperation(value: unknown): ToolOperationCancellationResult {
    const input = record(value);
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    const commandMayStillExist =
      this.#activeCommandStreams.has(`tool:${toolCallId}`) ||
      this.#activeCommandKills.has(`tool:${toolCallId}`) ||
      this.#toolOperations.pending().some((operation) => operation.toolCallId === toolCallId);
    const commandBackedOperation =
      this.#toolOperations.has(toolCallId) &&
      ['exec', 'npmInstall'].includes(this.#toolOperations.toolName(toolCallId));
    const result = this.#toolOperations.cancel({
      toolCallId,
      error: requireString(input.error, 'error', 4_000),
      active:
        this.#activeToolOperations.has(toolCallId) ||
        commandMayStillExist ||
        (commandBackedOperation &&
          this.#toolOperations.isRunning(toolCallId) &&
          !this.#ownedToolOperations.has(toolCallId) &&
          !this.#confirmedCommandCancellations.has(toolCallId)),
    });
    if (result.status === 'settled') {
      this.#ownedToolOperations.delete(toolCallId);
      this.#confirmedCommandCancellations.delete(toolCallId);
    }
    return result;
  }

  async getWorkspaceState(): Promise<WorkspaceState> {
    const snapshot = await this.stableProjectRead(readProjectFiles);
    return this.stateFromFiles(snapshot.value, snapshot.revision);
  }

  async runReadinessProbe() {
    const nonce = crypto.randomUUID();
    const path = `${READINESS_ROOT}/${nonce}.txt`;
    const containerNonce = `${nonce}-container`;
    try {
      await this.withComputer(async (workspace) => {
        await workspace.fs.rm(READINESS_ROOT, { recursive: true, force: true });
        await writeWorkspaceFile(workspace, path, new TextEncoder().encode(nonce), false);
        if (decodeUtf8((await readWorkspaceFile(workspace, path)).bytes) !== nonce) {
          throw new Error('Durable VFS sentinel mismatch.');
        }
        requireCommandSuccess(
          await runCommand(workspace, `printf %s ${shellQuote(containerNonce)} > ${shellQuote(path)}`, {
            cwd: '/home',
            backend: 'container-shell',
            timeoutMs: 7 * 60_000,
          }),
        );
      });
      const snapshot = await this.stableProjectRead((workspace) => readWorkspaceFile(workspace, path));
      if (decodeUtf8(snapshot.value.bytes) !== containerNonce) {
        throw new Error('FUSE sentinel mismatch.');
      }
    } finally {
      await this.cleanupReadinessRoot().catch(() => undefined);
    }
  }

  async getWorkspaceSnapshot() {
    const snapshot = await this.stableProjectRead(readProjectFiles);
    return {
      state: this.stateFromFiles(snapshot.value, snapshot.revision),
      files: snapshot.value.map((file) => workspaceFileMetadata(file, snapshot.revision)),
    };
  }

  async beginSeed(seedIdValue: unknown) {
    await this.#admission.admitNewOperation();
    const seedId = requireString(seedIdValue, 'seedId', 256);
    return this.withStatefulOperation('seed', `seed:begin:${seedId}`, async () => {
      const row = this.workspaceRow();
      if (row.initialized === 1) {
        return { status: 'initialized' as const, state: await this.getWorkspaceState() };
      }
      if (row.seed_id === seedId) {
        return { status: 'seeding' as const, state: await this.getWorkspaceState() };
      }
      await this.withComputer(async (workspace) => {
        await workspace.fs.rm(PROJECT_ROOT, { recursive: true, force: true });
        await workspace.fs.mkdir(PROJECT_ROOT, { recursive: true });
      });
      this.ctx.storage.sql.exec(
        `UPDATE ghostbuild_workspace_state
         SET initialized = 0, seed_id = ?, reset_revision = ?
         WHERE singleton = 1`,
        seedId,
        this.currentRevision(),
      );
      return { status: 'started' as const, seedId, state: await this.getWorkspaceState() };
    });
  }

  async appendSeed(seedIdValue: unknown, entriesValue: unknown) {
    const seedId = requireString(seedIdValue, 'seedId', 256);
    const entries = requireFileInputs(entriesValue);
    const key = `seed:append:${seedId}:${await sha256Text(JSON.stringify(entries))}`;
    return this.withStatefulOperation('seed', key, async () => {
      if (this.workspaceRow().seed_id !== seedId) {
        throw new Error('The workspace seed is no longer active.');
      }
      await this.withComputer(async (workspace) => {
        for (const entry of entries) {
          await writeWorkspaceFile(workspace, entry.path, decodeFileContent(entry.content, entry.encoding));
        }
      });
      return this.getWorkspaceState();
    });
  }

  async commitSeed(seedIdValue: unknown, expectedValue: unknown) {
    const seedId = requireString(seedIdValue, 'seedId', 256);
    const expected = record(expectedValue);
    const expectedFiles = requireInteger(expected.fileCount, 'fileCount', MAX_FILES);
    const expectedBytes = requireInteger(expected.totalBytes, 'totalBytes', MAX_TOTAL_BYTES);
    return this.withStatefulOperation('seed', `seed:commit:${seedId}:${expectedFiles}:${expectedBytes}`, async () => {
      if (this.workspaceRow().seed_id !== seedId) {
        throw new Error('The workspace seed is no longer active.');
      }
      const files = await this.withComputer(readProjectFiles);
      if (files.length !== expectedFiles || totalFileBytes(files) !== expectedBytes) {
        throw new Error('The workspace seed did not match the expected template.');
      }
      const revision = this.currentRevision();
      this.ctx.storage.sql.exec(
        `UPDATE ghostbuild_workspace_state
         SET initialized = 1, seed_id = NULL, reset_revision = ?
         WHERE singleton = 1`,
        revision,
      );
      return this.stateFromFiles(files);
    });
  }

  async abortSeed(seedIdValue: unknown) {
    const seedId = requireString(seedIdValue, 'seedId', 256);
    return this.withStatefulOperation('seed', `seed:abort:${seedId}`, async () => {
      if (this.workspaceRow().seed_id === seedId) {
        await this.withComputer((workspace) => workspace.fs.rm(PROJECT_ROOT, { recursive: true, force: true }));
        this.ctx.storage.sql.exec(
          `UPDATE ghostbuild_workspace_state SET initialized = 0, seed_id = NULL, reset_revision = ? WHERE singleton = 1`,
          this.currentRevision(),
        );
      }
      return this.getWorkspaceState();
    });
  }

  async applyChanges(value: unknown) {
    const input = record(value);
    const baseRevision = requireInteger(input.baseRevision, 'baseRevision', Number.MAX_SAFE_INTEGER);
    const changes = requireChanges(input.changes);
    const toolCallId =
      typeof input.toolCallId === 'string' ? requireString(input.toolCallId, 'toolCallId', 512) : undefined;
    const operationKey =
      typeof input.operationKey === 'string'
        ? requireString(input.operationKey, 'operationKey', 512)
        : `change:${baseRevision}:${await sha256Text(JSON.stringify(changes))}`;
    if (toolCallId) {
      this.#toolOperations.assertRunning(toolCallId);
      this.#activeToolOperations.add(toolCallId);
    }
    try {
      return await this.withStatefulOperation('write', operationKey, async (liveness) => {
        if (this.workspaceRow().seed_id !== null) {
          throw new WorkspaceOperationConflictError('seed', 1_000);
        }
        if (baseRevision !== this.currentRevision()) {
          failConflictedToolMutation(this.#toolOperations, toolCallId);
          return { ok: false as const, conflict: true as const, state: await this.getWorkspaceState() };
        }
        const existingFiles = await this.withComputer(readProjectFiles);
        if (baseRevision !== this.currentRevision()) {
          failConflictedToolMutation(this.#toolOperations, toolCallId);
          return { ok: false as const, conflict: true as const, state: await this.getWorkspaceState() };
        }
        const projectedFiles = new Map(existingFiles.map((file) => [file.path, { size: file.size, mode: file.mode }]));
        const decodedWrites = new Map<string, { bytes: Uint8Array; mode?: number; sha256: string }>();
        for (const change of changes) {
          if (change.kind === 'delete') {
            for (const path of projectedFiles.keys()) {
              if (path === change.path || path.startsWith(`${change.path}/`)) {
                projectedFiles.delete(path);
              }
            }
            continue;
          }
          const bytes = decodeFileContent(change.content, change.encoding);
          if (bytes.byteLength > MAX_FILE_BYTES) {
            throw new Error(`Workspace file exceeds ${MAX_FILE_BYTES} bytes.`);
          }
          const mode = change.mode ?? projectedFiles.get(change.path)?.mode;
          decodedWrites.set(change.path, { bytes, mode, sha256: await sha256Bytes(bytes) });
          projectedFiles.set(change.path, { size: bytes.byteLength, mode: mode ?? 0o644 });
        }
        if (
          projectedFiles.size > MAX_FILES ||
          [...projectedFiles.values()].reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES
        ) {
          throw new Error('The project workspace exceeds its size limit.');
        }
        const assertMutationAllowed = () => {
          // Each applied change is a step this operation demonstrably reached.
          liveness.observed();
          if (toolCallId) {
            this.#toolOperations.assertRunning(toolCallId);
          }
        };
        const atomicChanges: AtomicWorkspaceChange[] = changes.map((change) =>
          change.kind === 'delete'
            ? change
            : {
                kind: 'write' as const,
                path: change.path,
                ...decodedWrites.get(change.path)!,
              },
        );
        const changedPaths = applyAtomicWorkspaceChanges(this.#workspace, atomicChanges, assertMutationAllowed);
        const committedRevision = this.currentRevision();
        if (toolCallId) {
          this.#toolOperations.assertRunning(toolCallId);
          const toolName = this.#toolOperations.toolName(toolCallId);
          if (toolName === 'write' || toolName === 'edit') {
            this.#toolOperations.commitMutation({
              toolCallId,
              receipt: createCommittedMutationReceipt({
                tool: toolName,
                files: changes.map((change) => {
                  const write = change.kind === 'write' ? decodedWrites.get(change.path)! : null;
                  const file: MutationReceiptFileInput = {
                    path: change.path,
                    revision: committedRevision,
                    size: write?.bytes.byteLength ?? 0,
                    sha256: write?.sha256 ?? null,
                    deleted: change.kind === 'delete',
                  };
                  if (write) {
                    file.changedRange = {
                      startLine: 1,
                      endLine: canDecodeUtf8(write.bytes) ? decodeUtf8(write.bytes).split('\n').length : 1,
                    };
                  }
                  return file;
                }),
              }),
            });
          }
        }
        const state = await this.getWorkspaceState();
        return { ok: true as const, state, changedPaths };
      });
    } catch (error) {
      if (toolCallId) {
        this.#toolOperations.fail({
          toolCallId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      if (toolCallId) {
        this.#activeToolOperations.delete(toolCallId);
      }
    }
  }

  async getSyncPage(value: unknown) {
    const input = record(value);
    const fromRevision = requireInteger(input.fromRevision, 'fromRevision', Number.MAX_SAFE_INTEGER);
    const cursor = typeof input.cursor === 'string' ? decodeSyncCursor(input.cursor) : null;
    const targetRevision = cursor?.revision ?? this.currentRevision();
    const state = await this.getWorkspaceState();
    if (state.revision !== targetRevision) {
      return {
        state,
        fromRevision,
        targetRevision: state.revision,
        mode: 'snapshot' as const,
        entries: [],
        restart: true,
      };
    }
    if (!cursor && fromRevision === targetRevision) {
      return { state, fromRevision, targetRevision, mode: 'current' as const, entries: [] };
    }
    const files = await this.withComputer(readProjectFiles);
    const observedRevision = this.currentRevision();
    if (observedRevision !== targetRevision) {
      const currentState = await this.getWorkspaceState();
      return {
        state: currentState,
        fromRevision,
        targetRevision: currentState.revision,
        mode: 'snapshot' as const,
        entries: [],
        restart: true,
      };
    }
    const start = cursor?.index ?? 0;
    const page: WorkspaceFile[] = [];
    let bytes = 0;
    for (const file of files.slice(start)) {
      if (page.length >= SYNC_BATCH_FILES || (page.length > 0 && bytes + file.size > SYNC_BATCH_BYTES)) {
        break;
      }
      page.push(file);
      bytes += file.size;
    }
    const nextIndex = start + page.length;
    const nextCursor =
      nextIndex < files.length ? encodeSyncCursor({ revision: targetRevision, index: nextIndex }) : undefined;
    return {
      state,
      fromRevision,
      targetRevision,
      mode: 'snapshot' as const,
      entries: page.map((file) => fileSyncEntry(file, targetRevision)),
      nextCursor,
    };
  }

  async readText(pathValue: unknown) {
    const path = requireProjectPath(pathValue);
    const snapshot = await this.stableProjectRead((workspace) => readWorkspaceFile(workspace, path));
    const file = snapshot.value;
    const content = decodeUtf8(file.bytes);
    return {
      path,
      content,
      encoding: 'utf8' as const,
      size: file.size,
      sha256: file.sha256,
      revision: snapshot.revision,
    };
  }

  async readWorkspaceFile(pathValue: unknown) {
    const path = requireProjectPath(pathValue);
    const snapshot = await this.stableProjectRead((workspace) => readWorkspaceFile(workspace, path));
    const file = snapshot.value;
    return {
      path,
      bytes: file.bytes,
      encoding: canDecodeUtf8(file.bytes) ? ('utf8' as const) : ('base64' as const),
      size: file.size,
      mode: file.mode,
      sha256: file.sha256,
      revision: snapshot.revision,
    };
  }

  async streamWorkspaceFile(pathValue: unknown): Promise<ReadableStream<Uint8Array>> {
    const path = requireProjectPath(pathValue);
    const snapshot = await this.stableProjectRead((workspace) => readWorkspaceFile(workspace, path));
    return new Blob([new Uint8Array(snapshot.value.bytes)]).stream();
  }

  async listWorkspaceFiles() {
    const snapshot = await this.stableProjectRead(readProjectFiles);
    return snapshot.value.map((file) => workspaceFileMetadata(file, snapshot.revision));
  }

  async readDirectory(pathValue: unknown) {
    const path = requireProjectPath(pathValue, true);
    const snapshot = await this.stableProjectRead((workspace) => workspace.fs.readdir(path));
    return snapshot.value.map((entry) => ({
      name: entry.name,
      size: entry.size,
      mtime: entry.mtime,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
      isSymbolicLink: entry.isSymbolicLink,
    }));
  }

  /**
   * Start this workspace's container and computerd ahead of the work that needs them.
   *
   * Nothing before the model's first `exec` requires a container: seeding writes into the durable
   * VFS, and `read`/`ls`/`grep` are served from it. So the entire cold start — container boot,
   * the toolchain and computerd bootstraps, the FUSE mount — used to land in the middle of the
   * first turn, while the user watched. Opening a chat is the moment we learn a container will be
   * wanted, and the user is still typing, so that is when to pay for it.
   *
   * Deliberately outside the stateful operation lane: warming is not a mutation, and taking the
   * lane would make an optimisation block the first write it exists to speed up. Failure is not
   * an error either — the ordinary lazy path still runs, just cold, so this reports rather than
   * throws.
   */
  async warmContainer(): Promise<void> {
    try {
      await this.getWorkspaceContainer().start(COMPUTERD_ENV, false);
    } catch (error) {
      console.info('ProjectWorkspace container warm-up did not complete', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Discovery served from Computer's SQLite VFS alone: no container, no shell process, no
   * filesystem sync barrier, and never the exclusive stateful operation lane. `stableProjectRead`
   * is the read seam mutating operations do not share, so a listing or a search answers before
   * the container is warm and stays available while a build command holds the lane.
   */
  async listProjectEntries(value: unknown) {
    const request = record(value);
    const options = requireProjectListingOptions(request);
    const scope = this.discoveryScope(request.path);
    const snapshot = await this.stableProjectRead((workspace) => enumerateProjectEntries(workspace.fs, scope, options));
    return { ...snapshot.value, revision: snapshot.revision };
  }

  async searchProjectFiles(value: unknown) {
    const request = record(value);
    const options = requireProjectSearchOptions(request);
    const scope = this.discoveryScope(request.path);
    const snapshot = await this.stableProjectRead((workspace) => scanProjectFiles(workspace.fs, scope, options));
    return { ...snapshot.value, revision: snapshot.revision };
  }

  private discoveryScope(pathValue: unknown): DiscoveryScope {
    return {
      path: pathValue === undefined ? PROJECT_ROOT : requireProjectPath(pathValue, true),
      root: PROJECT_ROOT,
      prunedRoots: CHECKPOINT_EXCLUDED_ROOTS,
    };
  }

  async makeDirectory(pathValue: unknown) {
    const path = requireProjectPath(pathValue, true);
    await this.withStatefulOperation('write', `mkdir:${path}`, () =>
      this.withComputer((workspace) => workspace.fs.mkdir(path, { recursive: true })),
    );
  }

  async execute(value: unknown): Promise<WorkspaceRuntimeResult<'utf8'>> {
    const request = await this.commandRequest(value);
    if (request.toolCallId) {
      this.#toolOperations.assertRunning(request.toolCallId);
      this.#activeToolOperations.add(request.toolCallId);
    }
    const resume = this.resumesInterruptedExecution(request.toolCallId);
    const settlement = this.withStatefulOperation(
      'exec',
      request.operationKey,
      async (liveness) => {
        await this.assertContainerMatchesDurableProject();
        return this.withComputer((workspace) =>
          runCommand(workspace, request.command, {
            id: request.operationKey,
            resume,
            cwd: request.cwd,
            backend: request.backend,
            // A lifetime hint for computerd, unenforced client-side for
            // container-shell; the tool budget and lease govern (#128).
            timeoutMs: EXEC_COMMAND_TIMEOUT_MS,
            beforeExec: () => {
              liveness.observed();
              this.assertToolOperationRunning(request.toolCallId);
            },
            onHandle: (kill) => {
              this.#activeCommandKills.set(request.operationKey, kill);
              if (this.#pendingCommandCancellations.delete(request.operationKey)) {
                void kill().catch(() => undefined);
              }
            },
            onSyncPending: request.toolCallId
              ? (result) => {
                  this.recordPendingCommand(request, result);
                }
              : undefined,
          }),
        );
      },
      { resume },
    );
    this.#activeCommandSettlements.set(request.operationKey, settlement);
    try {
      return await settlement;
    } finally {
      this.#activeCommandKills.delete(request.operationKey);
      this.#activeCommandSettlements.delete(request.operationKey);
      this.#pendingCommandCancellations.delete(request.operationKey);
      if (request.toolCallId) {
        this.#activeToolOperations.delete(request.toolCallId);
      }
    }
  }

  async executeStream(value: unknown): Promise<ReadableStream<Uint8Array>> {
    const request = await this.commandRequest(value);
    if (request.toolCallId) {
      this.#toolOperations.assertRunning(request.toolCallId);
    }
    const encoder = new TextEncoder();
    let cancelCommand: (() => Promise<void>) | undefined;
    let cancelled = false;
    const resume = this.resumesInterruptedExecution(request.toolCallId);
    this.#activeCommandStreams.add(request.operationKey);
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const settlement = this.withStatefulOperation(
          'exec',
          request.operationKey,
          async (liveness) => {
            await this.assertContainerMatchesDurableProject();
            return this.withComputer((workspace) =>
              streamCommand(workspace, request.command, {
                id: request.operationKey,
                resume,
                cwd: request.cwd,
                backend: request.backend,
                // A lifetime hint for computerd, unenforced client-side for
                // container-shell; the tool budget and lease govern (#128).
                timeoutMs: EXEC_COMMAND_TIMEOUT_MS,
                beforeExec: () => {
                  liveness.observed();
                  this.assertToolOperationRunning(request.toolCallId);
                },
                emit: (event) => {
                  // Every streamed chunk is first-hand proof the command is running.
                  liveness.observed();
                  if (!cancelled) {
                    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
                  }
                },
                onHandle: (kill) => {
                  cancelCommand = kill;
                  this.#activeCommandKills.set(request.operationKey, kill);
                  if (cancelled || this.#pendingCommandCancellations.delete(request.operationKey)) {
                    void kill().catch(() => undefined);
                  }
                },
                onSyncPending: request.toolCallId
                  ? (result) => {
                      this.recordPendingCommand(request, result);
                    }
                  : undefined,
              }),
            );
          },
          { resume },
        );
        this.#activeCommandSettlements.set(request.operationKey, settlement);
        void settlement
          .then(
            () => {
              if (!cancelled) {
                controller.close();
              }
            },
            (error) => {
              if (!cancelled) {
                controller.error(error);
              }
            },
          )
          .finally(() => {
            this.#activeCommandKills.delete(request.operationKey);
            this.#activeCommandStreams.delete(request.operationKey);
            this.#activeCommandSettlements.delete(request.operationKey);
            this.#pendingCommandCancellations.delete(request.operationKey);
          });
      },
      cancel: async () => {
        cancelled = true;
        const settlement = this.#activeCommandSettlements.get(request.operationKey);
        const actions: Promise<unknown>[] = [];
        if (cancelCommand) {
          actions.push(
            boundCancellationAction(
              settleCancelledWorkspaceCommand({ termination: cancelCommand(), settlement }),
              'streamed command termination and observation',
            ),
          );
        } else {
          this.#pendingCommandCancellations.add(request.operationKey);
          if (settlement) {
            actions.push(
              boundCancellationAction(
                settleCancelledWorkspaceCommand({ settlement }),
                'pending streamed command termination and observation',
              ),
            );
          }
        }
        await settleCancellationActions(actions);
      },
    });
  }

  async cancelExecution(value: unknown): Promise<void> {
    const input = record(value);
    const operationKey = requireString(input.operationKey, 'operationKey', 512);
    const toolCallId = toolCallIdFromOperationKey(operationKey);
    const settlement = this.#activeCommandSettlements.get(operationKey);
    const kill = this.#activeCommandKills.get(operationKey);
    const actions: Promise<unknown>[] = [];
    if (kill) {
      actions.push(
        boundCancellationAction(
          settleCancelledWorkspaceCommand({ termination: kill(), settlement }),
          'exact command termination and observation',
        ),
      );
    } else if (
      this.#activeCommandStreams.has(operationKey) ||
      (toolCallId && this.#activeToolOperations.has(toolCallId))
    ) {
      this.#pendingCommandCancellations.add(operationKey);
    } else if (
      toolCallId &&
      this.#toolOperations.isRunning(toolCallId) &&
      !this.#ownedToolOperations.has(toolCallId) &&
      !this.#toolOperations.pending().some((operation) => operation.toolCallId === toolCallId)
    ) {
      const termination = this.withComputer((workspace) =>
        terminateWorkspaceCommand(workspace.runtime, operationKey, 'container-shell'),
      ).then((result) => {
        if (pendingWorkspaceRuntimeResult(result)) {
          this.registerPendingCommand({
            backend: 'container-shell',
            toolCallId,
            result: toolFailure(
              'The cancelled workspace command reached a terminal state, but its filesystem synchronization is still pending.',
            ),
          });
        }
        return result;
      });
      actions.push(
        boundCancellationAction(
          settleCancelledWorkspaceCommand({ termination, settlement }),
          'recovered command termination and observation',
        ).then(() => {
          this.#confirmedCommandCancellations.add(toolCallId);
          while (this.#confirmedCommandCancellations.size > MAX_CONFIRMED_COMMAND_CANCELLATIONS) {
            const oldest = this.#confirmedCommandCancellations.values().next().value;
            if (oldest === undefined) {
              break;
            }
            this.#confirmedCommandCancellations.delete(oldest);
          }
        }),
      );
    } else if (!toolCallId) {
      actions.push(
        boundCancellationAction(
          this.withComputer((workspace) =>
            terminateWorkspaceCommand(workspace.runtime, operationKey, 'container-shell'),
          ),
          'command termination',
        ),
      );
    }
    if (settlement && !kill && actions.length === 0) {
      actions.push(
        boundCancellationAction(
          settleCancelledWorkspaceCommand({ settlement }),
          'pending command termination and observation',
        ),
      );
    }
    await settleCancellationActions(actions);
    if (
      toolCallId &&
      this.#toolOperations.has(toolCallId) &&
      !this.#toolOperations.pending().some((operation) => operation.toolCallId === toolCallId)
    ) {
      this.#toolOperations.fail({ toolCallId, error: 'The workspace command was cancelled.' });
    }
  }

  private async commandRequest(value: unknown) {
    const input = record(value);
    const command = requireString(input.command, 'command', 64 * 1024);
    // Second enforcement of the builder/platform boundary: the model tool layer already rejects
    // these, so anything arriving here bypassed it and must still fail closed.
    const boundaryRejection = rejectedWorkspaceCommand(command);
    if (boundaryRejection) {
      throw new SyntaxError(boundaryRejection);
    }
    const cwd = input.cwd === undefined ? PROJECT_ROOT : requireProjectPath(input.cwd, true);
    const backend = requireBackend(input.backend);
    const operationKey =
      typeof input.operationKey === 'string'
        ? requireString(input.operationKey, 'operationKey', 512)
        : `exec:${await sha256Text(JSON.stringify([command, cwd, backend]))}`;
    return {
      command,
      cwd,
      backend,
      operationKey,
      toolCallId: toolCallIdFromOperationKey(operationKey),
    };
  }

  private recordPendingCommand(
    request: Awaited<ReturnType<ProjectWorkspace['commandRequest']>>,
    result: WorkspaceRuntimeResult<'utf8'>,
  ): void {
    if (!request.toolCallId) {
      return;
    }
    this.registerPendingCommand({
      backend: request.backend,
      toolCallId: request.toolCallId,
      result: {
        command: request.command,
        cwd: request.cwd,
        backend: request.backend,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    });
  }

  async checkpoint() {
    const initialRevision = this.currentRevision();
    const files = await this.withComputer(readProjectFiles);
    const revision = await sha256Text(
      JSON.stringify(files.map((file) => [relativeProjectPath(file.path), file.mode, file.sha256])),
    );
    if (this.currentRevision() !== initialRevision) {
      throw new Error('The project workspace changed while its checkpoint was created.');
    }
    return { workspaceRevision: initialRevision, revision };
  }

  async installDependenciesTool(value: unknown): Promise<GhostbuildToolResult> {
    const input = record(value);
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    const mode = input.mode === 'sync-lockfile' ? 'sync-lockfile' : input.mode === 'add' ? 'add' : null;
    const packages = requireStringArray(input.packages, 'packages', 100);
    if (!mode) {
      throw new SyntaxError('Invalid dependency installation mode.');
    }
    return this.runToolOperation(toolCallId, 'npmInstall', { input: input.input, mode, packages }, () => {
      const operationKey = `tool:${toolCallId}`;
      const settlement = this.withStatefulOperation('install', operationKey, async (liveness) => {
        const startedAt = Date.now();
        return this.withComputer(async (workspace) => {
          const assertMutationAllowed = () => {
            liveness.observed();
            this.#toolOperations.assertRunning(toolCallId);
          };
          const packagePath = `${PROJECT_ROOT}/package.json`;
          const lockfilePath = `${PROJECT_ROOT}/pnpm-lock.yaml`;
          const stagingRoot = `${ISOLATED_PROJECT_ROOT}/install-${crypto.randomUUID()}`;
          const stagedPackagePath = `${stagingRoot}/package.json`;
          const stagedLockfilePath = `${stagingRoot}/pnpm-lock.yaml`;
          const current = decodeUtf8((await readWorkspaceFile(workspace, packagePath)).bytes);
          const next = mode === 'sync-lockfile' ? current : addRequestedDependencies(current, packages);
          try {
            await this.mkdir(stagingRoot, { recursive: true });
            assertMutationAllowed();
            await this.writeFile(stagedPackagePath, next, { encoding: 'utf8' });
            assertMutationAllowed();
            const installationCommand = [
              'set -eu',
              `if [ -f ${shellQuote(lockfilePath)} ]; then cp ${shellQuote(lockfilePath)} ${shellQuote(stagedLockfilePath)}; fi`,
              'pnpm install --lockfile-only --ignore-scripts=true --ignore-pnpmfile --registry=https://registry.npmjs.org/',
            ].join('\n');
            const installation = runCommand(workspace, installationCommand, {
              id: operationKey,
              cwd: stagingRoot,
              backend: 'container-shell',
              timeoutMs: INSTALL_TIMEOUT_MS,
              beforeExec: assertMutationAllowed,
              onHandle: (kill) => {
                this.#activeCommandKills.set(operationKey, kill);
                if (this.#pendingCommandCancellations.delete(operationKey)) {
                  void kill().catch(() => undefined);
                }
              },
            });
            try {
              requireCommandSuccess(await installation);
            } finally {
              this.#activeCommandKills.delete(operationKey);
              this.#pendingCommandCancellations.delete(operationKey);
            }

            const [stagedPackage, stagedLockfile] = await Promise.all([
              this.readFile(stagedPackagePath, { encoding: 'none' }),
              this.readFile(stagedLockfilePath, { encoding: 'none' }),
            ]);
            if (stagedPackage.size > MAX_FILE_BYTES || stagedLockfile.size > MAX_FILE_BYTES) {
              throw new Error('The generated package manifest or lockfile exceeds the workspace file limit.');
            }
            const [packageBytes, lockfileBytes] = await Promise.all([
              readStream(stagedPackage.content, stagedPackage.size),
              readStream(stagedLockfile.content, stagedLockfile.size),
            ]);
            const existingFiles = await readProjectFiles(workspace);
            const replacedPaths = new Set([packagePath, lockfilePath]);
            const retainedFiles = existingFiles.filter((file) => !replacedPaths.has(file.path));
            if (
              retainedFiles.length + 2 > MAX_FILES ||
              totalFileBytes(retainedFiles) + packageBytes.byteLength + lockfileBytes.byteLength > MAX_TOTAL_BYTES
            ) {
              throw new Error('The project workspace exceeds its size limit.');
            }
            assertMutationAllowed();
            applyAtomicWorkspaceChanges(
              this.#workspace,
              [
                { kind: 'write', path: packagePath, bytes: packageBytes },
                { kind: 'write', path: lockfilePath, bytes: lockfileBytes },
              ],
              assertMutationAllowed,
            );
            const result = toolSuccess(
              mode === 'sync-lockfile'
                ? 'Synchronized the durable project lockfile with package.json.'
                : `Installed ${packages.length} dependency package${packages.length === 1 ? '' : 's'} in the durable project.`,
              {
                mode,
                workspaceRevision: this.currentRevision(),
                buildEnvironment: 'cloudflare-computer-container',
                durationMs: Date.now() - startedAt,
              },
            );
            // Publish and journal completion are contiguous synchronous boundaries, so a known commit wins cancellation.
            this.#toolOperations.complete({ toolCallId, result });
            return result;
          } finally {
            await this.runTransientCommand('/', `rm -rf ${shellQuote(stagingRoot)}`, 30_000).catch(() => undefined);
          }
        });
      });
      this.#activeCommandSettlements.set(operationKey, settlement);
      return settlement.finally(() => {
        this.#activeCommandKills.delete(operationKey);
        this.#activeCommandSettlements.delete(operationKey);
        this.#pendingCommandCancellations.delete(operationKey);
      });
    });
  }

  async validateTool(value: unknown, onStage?: WorkspaceValidationStageReporter): Promise<GhostbuildToolResult> {
    const input = record(value);
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    const reportStage = validationStageReporter(onStage);
    const inputJson = JSON.stringify(stableValue(input.input)) ?? 'null';
    if (this.#activeValidation) {
      if (this.#activeValidation.toolCallId === toolCallId) {
        if (this.#activeValidation.inputJson !== inputJson) {
          throw new Error('A workspace tool-call identifier was reused with different arguments.');
        }
        return this.#activeValidation.promise;
      }
      throw new Error('ProjectWorkspace validation is already running.');
    }
    const cancellation = new ValidationCancellation();
    const validation = this.runValidationTool(toolCallId, input.input, cancellation, reportStage);
    const activeRecord = { toolCallId, inputJson, cancellation, promise: validation };
    this.#activeValidation = activeRecord;
    try {
      return await validation;
    } finally {
      if (this.#activeValidation === activeRecord) {
        this.#activeValidation = null;
      }
    }
  }

  async cancelValidation(value: unknown): Promise<void> {
    const input = record(value);
    const toolCallId = input.toolCallId === undefined ? null : requireString(input.toolCallId, 'toolCallId', 512);
    const active = this.#activeValidation;
    if (!active || (toolCallId !== null && active.toolCallId !== toolCallId)) {
      return;
    }
    await Promise.race([
      Promise.all([active.cancellation.cancel(), active.promise.catch(() => undefined)]).then(() => undefined),
      scheduler.wait(VALIDATION_CANCELLATION_SETTLE_MS).then(() => {
        throw new Error('Project validation did not settle after cancellation.');
      }),
    ]);
  }

  private runValidationTool(
    toolCallId: string,
    input: unknown,
    cancellation: ValidationCancellation,
    reportStage: (stage: BuilderValidationStage) => void = () => undefined,
  ): Promise<GhostbuildToolResult> {
    return this.runToolOperation(toolCallId, 'validation', input, () =>
      this.withStatefulOperation('validate', `tool:${toolCallId}`, async (liveness) => {
        cancellation.requireActive();
        const before = await this.checkpoint();
        cancellation.requireActive();
        const startedAt = Date.now();
        const isolatedRoot = PREPARED_VALIDATION_ROOT;
        let artifactPrepared = false;
        let cleanupAllowed = true;
        try {
          reportStage('preparing');
          await this.discardPreparedValidationArtifact();
          await this.copyProjectToIsolatedRoot(isolatedRoot, cancellation);
          cancellation.requireActive();
          if ((await this.checkpoint()).revision !== before.revision) {
            throw new Error('The project changed while validation was being isolated. Validate the new revision.');
          }
          reportStage('installing');
          await this.runTransientCommand(isolatedRoot, INSTALL_COMMAND, INSTALL_TIMEOUT_MS, cancellation);
          liveness.observed();
          reportStage('typecheck');
          await this.runTransientCommand(
            isolatedRoot,
            REVISION_CODEGEN_COMMAND.command,
            REVISION_CODEGEN_COMMAND.timeoutMs,
            cancellation,
          );
          liveness.observed();
          reportStage('lint');
          await this.runTransientCommand(
            isolatedRoot,
            parallelValidationStagesCommand(PARALLEL_VALIDATION_STAGES, {
              logRoot: VALIDATION_STAGE_LOG_ROOT,
            }),
            parallelStagesTimeoutMs(PARALLEL_VALIDATION_STAGES),
            cancellation,
          );
          liveness.observed();
          const project = await this.readDeploymentProjectProfile();
          const artifact = await this.buildDeploymentArtifact({
            revision: before.revision,
            isolatedRoot,
            artifactRoot: PREPARED_VALIDATION_ARTIFACT_ROOT,
            wranglerConfigPath: PREPARED_VALIDATION_CONFIG,
            project,
            deploymentConfig: validationDeploymentConfig(project),
            cancellation,
            liveness,
            // The build reports the same stage ladder the deployment records as activity, so the
            // wait the user watches is the one the container is actually in.
            activity: (sequence) => {
              const stage = BUILD_ARTIFACT_STAGES.get(sequence);
              if (stage) {
                reportStage(stage);
              }
              return Promise.resolve();
            },
          });
          const artifactDigest = await preparedDeploymentArtifactDigest(artifact);
          cancellation.requireActive();
          const after = await this.checkpoint();
          cancellation.requireActive();
          if (after.revision !== before.revision) {
            throw new Error('The project changed while validation was running. Validate the new revision.');
          }
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
              `INSERT INTO ghostbuild_validations (revision, workspace_revision, validated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(revision) DO UPDATE SET workspace_revision = excluded.workspace_revision,
                 validated_at = excluded.validated_at`,
              after.revision,
              after.workspaceRevision,
              Date.now(),
            );
            this.storePreparedValidationArtifact(after, artifactDigest);
          });
          artifactPrepared = true;
          return toolSuccess(`Project validation passed at durable source revision ${after.revision}.`, {
            level: 'full',
            revision: after.revision,
            workspaceRevision: after.workspaceRevision,
            buildEnvironment: 'cloudflare-computer-container',
            checks: [
              'workspace-policy',
              'dependency-installation',
              'typecheck',
              'stack-verification',
              'lint',
              'license-verification',
              'production-build',
              'worker-dry-run',
              ...(project.type === 'web_app' ? ['worker-bundle'] : []),
            ].map((name) => ({ name, status: 'passed' as const })),
            durationMs: Date.now() - startedAt,
            nextAction: 'prepare-deployment',
          });
        } catch (error) {
          cleanupAllowed = !(error instanceof SandboxProcessTerminationUnconfirmedError);
          if (error instanceof WorkspaceSyncPendingError) {
            throw error;
          }
          return toolFailure(error instanceof Error ? error.message.slice(-4_000) : 'User-owned validation failed.', {
            level: 'full',
            revision: before.revision,
            workspaceRevision: before.workspaceRevision,
            currentWorkspaceRevision: this.currentRevision(),
            buildEnvironment: 'cloudflare-computer-container',
            checks: [{ name: 'revision-finalization', status: 'failed' as const }],
          });
        } finally {
          if (!artifactPrepared && cleanupAllowed) {
            await this.runTransientCommand(PROJECT_ROOT, `rm -rf ${shellQuote(isolatedRoot)}`, 30_000).catch(
              () => undefined,
            );
          }
        }
      }),
    );
  }

  validationStatus(revision: unknown) {
    return { valid: typeof revision === 'string' && this.hasSuccessfulValidation(revision) };
  }

  async deploymentPlan(revisionValue: unknown) {
    const revision = requireString(revisionValue, 'revision', 64);
    if (!this.hasSuccessfulValidation(revision)) {
      throw new Error('Deployment requires successful validation of this exact revision.');
    }
    const checkpoint = await this.checkpoint();
    if (checkpoint.revision !== revision) {
      throw new Error('The durable project changed after validation. Run full validation again.');
    }
    return {
      ...checkpoint,
      project: await this.readDeploymentProjectProfile(),
    };
  }

  async beginDeploymentSession(value: unknown) {
    this.requireCompletedComputerSync();
    const input = record(value);
    const operationId = requireString(input.operationId, 'operationId', 256);
    const expectedWorkspaceRevision = requireInteger(
      input.expectedWorkspaceRevision,
      'expectedWorkspaceRevision',
      Number.MAX_SAFE_INTEGER,
    );
    const expectedSnapshotRevision = requireSnapshotRevision(input.expectedSnapshotRevision);
    const idempotencyKey = `deployment-session:${operationId}`;
    const owner = `deployment:${operationId}`;
    const existing = this.deploymentSessionRow(operationId);
    if (existing) {
      assertDeploymentSessionIdentity(existing, expectedWorkspaceRevision, expectedSnapshotRevision);
      if (existing.status !== 'active') {
        throw new WorkspaceOperationIndeterminateError('deployment');
      }
      const lease = this.#operationLane.find(existing.idempotency_key, existing.owner);
      if (!lease || lease.deadline <= Date.now()) {
        this.ctx.storage.sql.exec(
          `UPDATE ghostbuild_deployment_sessions SET status = 'indeterminate', updated_at = ?
           WHERE operation_id = ? AND status = 'active'`,
          Date.now(),
          operationId,
        );
        throw new WorkspaceOperationIndeterminateError('deployment');
      }
      await this.setKeepAlive(true);
      await this.assertDeploymentSession({ sessionId: operationId });
      return;
    }

    const lease = this.#operationLane.acquire({
      owner,
      idempotencyKey,
      kind: 'deployment',
      leaseMs: OPERATION_LEASE_MS.deployment,
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO ghostbuild_deployment_sessions (
         operation_id, owner, idempotency_key, expected_workspace_revision,
         expected_snapshot_revision, acquired_at, deadline, status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      operationId,
      owner,
      idempotencyKey,
      expectedWorkspaceRevision,
      expectedSnapshotRevision,
      lease.acquiredAt,
      lease.deadline,
      lease.acquiredAt,
    );
    try {
      // A publication session keeps the validation artifact's container alive while the control
      // plane performs migrations and version upload through the user's account API.
      await this.setKeepAlive(true);
      await this.assertDeploymentSession({ sessionId: operationId });
    } catch (error) {
      await this.finishDeploymentSession({ sessionId: operationId, status: 'failed' }).catch(() => undefined);
      throw error;
    }
  }

  async assertDeploymentSession(value: unknown) {
    this.requireCompletedComputerSync();
    const sessionId = requireString(record(value).sessionId, 'sessionId', 256);
    const session = this.requireActiveDeploymentSession(sessionId);
    this.#activeOperationOwners.add(session.owner);
    try {
      const lease = this.deploymentSessionLease(session);
      const renewed = this.#operationLane.renew(lease, OPERATION_LEASE_MS.deployment);
      this.ctx.storage.sql.exec(
        `UPDATE ghostbuild_deployment_sessions SET deadline = ?, updated_at = ?
         WHERE operation_id = ? AND status = 'active'`,
        renewed.deadline,
        Date.now(),
        sessionId,
      );
      const checkpoint = await this.checkpoint();
      if (checkpoint.revision !== session.expected_snapshot_revision) {
        console.error('ProjectWorkspace deployment checkpoint mismatch', {
          sessionId,
          expectedWorkspaceRevision: session.expected_workspace_revision,
          currentWorkspaceRevision: checkpoint.workspaceRevision,
          expectedSnapshotRevision: session.expected_snapshot_revision,
          currentSnapshotRevision: checkpoint.revision,
        });
        throw new Error('The project changed during its deployment session. Publication was cancelled.');
      }
      return checkpoint;
    } finally {
      this.#activeOperationOwners.delete(session.owner);
    }
  }

  async terminalizeInterruptedDeploymentSession(value: unknown) {
    const sessionId = requireString(record(value).sessionId, 'sessionId', 256);
    const session = this.deploymentSessionRow(sessionId);
    if (!session) {
      return;
    }
    const lease = this.#operationLane.find(session.idempotency_key, session.owner);
    if (lease) {
      this.#operationLane.release(lease);
    }
    this.#activeOperationOwners.delete(session.owner);
    if (session.status !== 'completed' && session.status !== 'failed') {
      this.ctx.storage.sql.exec(
        `UPDATE ghostbuild_deployment_sessions SET status = 'failed', updated_at = ?
         WHERE operation_id = ? AND status IN ('active', 'indeterminate')`,
        Date.now(),
        sessionId,
      );
    }
    await this.releaseContainerKeepAliveIfIdle();
  }

  async finishDeploymentSession(value: unknown) {
    const input = record(value);
    const sessionId = requireString(input.sessionId, 'sessionId', 256);
    const status = input.status === 'completed' ? 'completed' : input.status === 'failed' ? 'failed' : null;
    if (!status) {
      throw new SyntaxError('Invalid deployment session status.');
    }
    const session = this.deploymentSessionRow(sessionId);
    if (!session) {
      throw new Error('The deployment session does not exist.');
    }
    if (session.status === status) {
      const lease = this.#operationLane.find(session.idempotency_key, session.owner);
      if (lease) {
        this.#operationLane.release(lease);
      }
      this.#activeOperationOwners.delete(session.owner);
      await this.releaseContainerKeepAliveIfIdle();
      return;
    }
    if (session.status !== 'active') {
      throw new WorkspaceOperationIndeterminateError('deployment');
    }
    const lease = this.#operationLane.find(session.idempotency_key, session.owner);
    if (lease) {
      this.#operationLane.release(lease);
    }
    this.ctx.storage.sql.exec(
      `UPDATE ghostbuild_deployment_sessions SET status = ?, updated_at = ?
       WHERE operation_id = ? AND status = 'active'`,
      status,
      Date.now(),
      sessionId,
    );
    this.#activeOperationOwners.delete(session.owner);
    await this.releaseContainerKeepAliveIfIdle();
  }

  async prepareDeploymentArtifact(value: unknown): Promise<PreparedDeploymentArtifact> {
    this.requireCompletedComputerSync();
    const input = record(value);
    const sessionId = requireString(input.sessionId, 'sessionId', 256);
    const operationId = requireString(input.operationId, 'operationId', 256);
    const revision = requireString(input.revision, 'revision', 64);
    const deploymentId = requireString(input.deploymentId, 'deploymentId', 128);
    const executionGeneration = requireInteger(
      input.executionGeneration,
      'executionGeneration',
      Number.MAX_SAFE_INTEGER,
    );
    const session = this.requireActiveDeploymentSession(sessionId);
    if (session.operation_id !== operationId || sessionId !== operationId) {
      throw new Error('The deployment activity identity does not match its active deployment session.');
    }
    if (revision !== session.expected_snapshot_revision) {
      throw new Error('The deployment artifact revision does not match its active deployment session.');
    }
    const projectType = input.projectType === 'worker' ? 'worker' : input.projectType === 'web_app' ? 'web_app' : null;
    if (!projectType) {
      throw new SyntaxError('Invalid deployment project type.');
    }
    const d1DatabaseId = requireOptionalString(input.d1DatabaseId, 'd1DatabaseId', 64);
    const agentSecurityD1DatabaseId = requireOptionalString(
      input.agentSecurityD1DatabaseId,
      'agentSecurityD1DatabaseId',
      64,
    );
    const r2BucketName = requireOptionalString(input.r2BucketName, 'r2BucketName', 64);
    const kvNamespaceId = requireOptionalString(input.kvNamespaceId, 'kvNamespaceId', 64);
    const project: DeploymentProjectProfile = {
      type: projectType,
      bindings: {
        ai: input.workersAi === true,
        d1: d1DatabaseId !== undefined,
        r2: r2BucketName !== undefined,
        kv: kvNamespaceId !== undefined,
        appAgent: input.appAgent === true,
      },
    };
    if (project.bindings.appAgent !== (agentSecurityD1DatabaseId !== undefined)) {
      throw new Error('The deployment artifact bindings do not match the AppAgent security profile.');
    }
    const deploymentConfig: DeploymentConfigInput = {
      accountId: requireString(input.accountId, 'accountId', 64),
      workerName: requireCloudflareName(input.workerName, 'workerName'),
      projectType,
      workersAi: project.bindings.ai,
      appAgent: project.bindings.appAgent,
    };
    if (d1DatabaseId !== undefined) {
      deploymentConfig.d1DatabaseId = d1DatabaseId;
      deploymentConfig.d1DatabaseName = requireCloudflareName(input.d1DatabaseName, 'd1DatabaseName');
    }
    if (agentSecurityD1DatabaseId !== undefined) {
      deploymentConfig.agentSecurityD1DatabaseId = agentSecurityD1DatabaseId;
      deploymentConfig.agentSecurityD1DatabaseName = requireCloudflareName(
        input.agentSecurityD1DatabaseName,
        'agentSecurityD1DatabaseName',
      );
    }
    if (r2BucketName !== undefined) {
      deploymentConfig.r2BucketName = requireCloudflareName(r2BucketName, 'r2BucketName');
    }
    if (kvNamespaceId !== undefined) {
      deploymentConfig.kvNamespaceId = kvNamespaceId;
    }
    const activity = (sequence: number, message: string) =>
      recordDeploymentActivity({
        db: this.env.DB,
        deploymentId,
        executionGeneration,
        sequence,
        message,
      });

    this.#activeOperationOwners.add(session.owner);
    const operation = async () => {
      await this.assertDeploymentSession({ sessionId });
      if (!/^[a-f0-9]{64}$/.test(revision) || !this.hasSuccessfulValidation(revision)) {
        throw new Error('Deployment requires successful validation of this exact revision.');
      }
      const checkpoint = await this.checkpoint();
      if (checkpoint.revision !== revision || checkpoint.workspaceRevision !== session.expected_workspace_revision) {
        throw new Error('The durable project changed after validation. Run full validation again.');
      }

      const prepared = this.preparedValidationArtifact();
      const preparedMatchesRevision =
        prepared?.revision === revision && prepared.workspace_revision === checkpoint.workspaceRevision;
      const canReuse =
        preparedMatchesRevision &&
        prepared.snapshot_root === PREPARED_VALIDATION_ROOT &&
        (await this.exists(PREPARED_VALIDATION_ARTIFACT_ROOT)).exists;
      let artifact: PreparedDeploymentArtifact;
      if (canReuse) {
        await activity(31, 'Reusing validated build artifact');
        artifact = await this.collectDeploymentArtifact({
          revision,
          isolatedRoot: PREPARED_VALIDATION_ROOT,
          artifactRoot: PREPARED_VALIDATION_ARTIFACT_ROOT,
          project,
        });
        const observedDigest = await preparedDeploymentArtifactDigest(artifact);
        if (prepared.artifact_digest === null) {
          this.storePreparedValidationArtifact(checkpoint, observedDigest);
        } else if (prepared.artifact_digest !== observedDigest) {
          throw new Error('The retained deployment artifact no longer matches the bytes produced by validation.');
        }
      } else {
        const expectedDigest = preparedMatchesRevision ? prepared.artifact_digest : null;
        let cleanupAllowed = true;
        try {
          await activity(31, 'Restoring validated source artifact');
          await this.discardPreparedValidationArtifact();
          // A recycled container loses only this cache. Rebuilding is allowed, but the resulting
          // inventory must equal validation's durable digest when one survived the recycle.
          await this.copyProjectToIsolatedRoot(PREPARED_VALIDATION_ROOT);
          await this.assertDeploymentSession({ sessionId });
          await activity(32, 'Installing app dependencies');
          await this.runTransientCommand(PREPARED_VALIDATION_ROOT, INSTALL_COMMAND, INSTALL_TIMEOUT_MS);
          artifact = await this.buildDeploymentArtifact({
            revision,
            isolatedRoot: PREPARED_VALIDATION_ROOT,
            artifactRoot: PREPARED_VALIDATION_ARTIFACT_ROOT,
            wranglerConfigPath: PREPARED_VALIDATION_CONFIG,
            project,
            deploymentConfig,
            activity,
          });
          const observedDigest = await preparedDeploymentArtifactDigest(artifact);
          if (expectedDigest !== null && expectedDigest !== observedDigest) {
            throw new Error('The rebuilt deployment artifact differs from the bytes produced by validation.');
          }
          this.storePreparedValidationArtifact(checkpoint, observedDigest);
        } catch (error) {
          cleanupAllowed = !(error instanceof SandboxProcessTerminationUnconfirmedError);
          throw error;
        } finally {
          if (cleanupAllowed && !(await this.exists(PREPARED_VALIDATION_ARTIFACT_ROOT)).exists) {
            await this.discardPreparedValidationArtifact().catch(() => undefined);
          }
        }
      }

      if ((await this.checkpoint()).revision !== revision) {
        throw new Error('The project changed while its deployment artifact was prepared. Validate the new revision.');
      }
      await this.assertDeploymentSession({ sessionId });
      return artifact;
    };
    try {
      return await this.withContainerKeepAlive(operation);
    } finally {
      this.#activeOperationOwners.delete(session.owner);
    }
  }

  async deleteProject() {
    await this.withStatefulOperation('delete', 'delete:project', async () => {
      await this.withComputer((workspace) => workspace.fs.rm(PROJECT_ROOT, { recursive: true, force: true }));
      this.ctx.storage.sql.exec('DELETE FROM ghostbuild_validations');
      this.ctx.storage.sql.exec('DELETE FROM ghostbuild_prepared_validation');
      this.ctx.storage.sql.exec(
        `UPDATE ghostbuild_workspace_state
         SET initialized = 0, seed_id = NULL, reset_revision = ?
         WHERE singleton = 1`,
        this.currentRevision(),
      );
    });
    await this.destroy().catch(() => undefined);
  }

  private async readDeploymentProjectProfile(): Promise<DeploymentProjectProfile> {
    const [packageFile, wranglerFile] = await Promise.all([
      this.readText(`${PROJECT_ROOT}/package.json`),
      this.readText(`${PROJECT_ROOT}/wrangler.jsonc`),
    ]);
    const packageJson: unknown = JSON.parse(packageFile.content);
    const ghostbuild = isRecord(packageJson) ? packageJson.ghostbuild : undefined;
    const configuredType = isRecord(ghostbuild) ? ghostbuild.projectType : undefined;
    if (configuredType !== undefined && configuredType !== 'web_app' && configuredType !== 'worker') {
      throw new Error('The generated project type is invalid.');
    }
    const wrangler: unknown = parse(wranglerFile.content);
    if (!isRecord(wrangler)) {
      throw new Error('The generated Worker entrypoint is invalid.');
    }
    return deploymentProjectProfileFromConfig(wrangler, configuredType === 'worker' ? 'worker' : 'web_app');
  }

  private async buildDeploymentArtifact(args: {
    revision: string;
    isolatedRoot: string;
    artifactRoot: string;
    wranglerConfigPath: string;
    project: DeploymentProjectProfile;
    deploymentConfig: DeploymentConfigInput;
    cancellation?: ValidationCancellation;
    liveness?: OperationLiveness;
    activity?: (sequence: number, message: string) => Promise<void>;
  }): Promise<PreparedDeploymentArtifact> {
    await args.activity?.(33, 'Building production app');
    await this.runTransientCommand(args.isolatedRoot, 'pnpm run build', 5 * 60_000, args.cancellation);
    args.liveness?.observed();
    args.cancellation?.requireActive();
    const configWrite = await this.writeFile(
      args.wranglerConfigPath,
      JSON.stringify(
        rebaseDeploymentConfigPaths(createTrustedDeploymentConfig(args.deploymentConfig), {
          projectRoot: PROJECT_ROOT,
          isolatedRoot: args.isolatedRoot,
        }),
      ),
      { encoding: 'utf-8' },
    );
    if (!configWrite.success) {
      throw new Error('The isolated deployment configuration could not be written.');
    }
    await args.activity?.(34, 'Checking Cloudflare deployment package');
    await this.runTransientCommand(
      args.isolatedRoot,
      `pnpm exec wrangler deploy --dry-run --outdir ${shellQuote(args.artifactRoot)} --config ${shellQuote(args.wranglerConfigPath)}`,
      10 * 60_000,
      args.cancellation,
    );
    args.liveness?.observed();
    args.cancellation?.requireActive();
    if (args.project.type === 'web_app') {
      // Collapse Wrangler's verified web-app output to one module so the later versions API
      // upload cannot acknowledge a multipart request while omitting a generated module.
      const builtMainPath = `${args.isolatedRoot}/dist/server/index.js`;
      const mainPath = `${args.artifactRoot}/index.js`;
      const bundledPath = `${args.isolatedRoot}/.ghostbuild-worker.js`;
      await args.activity?.(35, 'Bundling Worker modules');
      await this.runTransientCommand(
        args.isolatedRoot,
        `node --input-type=module --eval ${shellQuote(WEB_APP_BUNDLE_SCRIPT)} ${shellQuote(builtMainPath)} ${shellQuote(bundledPath)}`,
        2 * 60_000,
        args.cancellation,
      );
      await this.runTransientCommand('/', `rm -rf ${shellQuote(args.artifactRoot)}`, 30_000, args.cancellation);
      await this.runTransientCommand('/', `mkdir -p ${shellQuote(args.artifactRoot)}`, 30_000, args.cancellation);
      await this.runTransientCommand(
        '/',
        `mv ${shellQuote(bundledPath)} ${shellQuote(mainPath)}`,
        30_000,
        args.cancellation,
      );
      args.liveness?.observed();
    }
    await args.activity?.(36, 'Build artifact ready');
    return this.collectDeploymentArtifact(args);
  }

  private async collectDeploymentArtifact(args: {
    revision: string;
    isolatedRoot: string;
    artifactRoot: string;
    project: DeploymentProjectProfile;
  }): Promise<PreparedDeploymentArtifact> {
    const artifact: PreparedDeploymentArtifact = {
      revision: args.revision,
      mainModule: args.project.type === 'worker' ? 'server.js' : 'index.js',
      modules: await collectSandboxFiles(this, args.artifactRoot, (path) => /\.(?:js|mjs|wasm)$/.test(path)),
      assets:
        args.project.type === 'web_app'
          ? await collectSandboxFiles(
              this,
              `${args.isolatedRoot}/dist/client`,
              (path) => path !== '.assetsignore' && !path.endsWith('.map'),
            )
          : [],
      migrations: {
        DB: args.project.bindings.d1 ? await collectSandboxMigrations(this, `${args.isolatedRoot}/migrations`) : [],
        AGENT_SECURITY_DB: args.project.bindings.appAgent
          ? await collectSandboxMigrations(this, `${args.isolatedRoot}/agent-security-migrations`)
          : [],
      },
    };
    return validatePreparedDeploymentArtifact(artifact, {
      revision: args.revision,
      projectType: args.project.type,
    });
  }

  private storePreparedValidationArtifact(
    checkpoint: { revision: string; workspaceRevision: number },
    artifactDigest: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO ghostbuild_prepared_validation (
         singleton, revision, workspace_revision, snapshot_root, artifact_digest
       ) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision,
         workspace_revision = excluded.workspace_revision,
         snapshot_root = excluded.snapshot_root,
         artifact_digest = excluded.artifact_digest`,
      checkpoint.revision,
      checkpoint.workspaceRevision,
      PREPARED_VALIDATION_ROOT,
      artifactDigest,
    );
  }

  private async discardPreparedValidationArtifact(): Promise<void> {
    // Keep the durable digest until a replacement artifact is complete. If this cleanup is
    // followed by an interrupted rebuild, the next fallback must still prove its bytes equal the
    // last successful validation rather than silently rebuilding without an expected identity.
    await this.runTransientCommand('/', `rm -rf ${shellQuote(PREPARED_VALIDATION_ROOT)}`, 30_000).catch(
      () => undefined,
    );
  }

  private async copyProjectToIsolatedRoot(isolatedRoot: string, cancellation?: ValidationCancellation): Promise<void> {
    await this.runTransientCommand(
      '/',
      ['set -eu', `rm -rf ${shellQuote(isolatedRoot)}`, `mkdir -p ${shellQuote(isolatedRoot)}`].join('\n'),
      2 * 60_000,
      cancellation,
    );
    cancellation?.requireActive();

    const files = (await this.withComputer(readProjectFilePaths)).map((path) => ({
      path,
      target: isolatedTargetPath({ isolatedRoot, projectRoot: PROJECT_ROOT, path }),
    }));
    cancellation?.requireActive();

    for (const directory of requiredDirectories(
      files.map((file) => file.target),
      isolatedRoot,
    )) {
      await this.mkdir(directory, { recursive: true });
    }
    cancellation?.requireActive();

    await forEachConcurrently(files, MATERIALIZATION_CONCURRENCY, async (file) => {
      cancellation?.requireActive();
      const source = await this.withComputer((workspace) => readWorkspaceFile(workspace, file.path));
      if (!(await this.writeContainerFile(file.target, source.bytes)).success) {
        throw new Error(`The isolated build root could not receive ${file.target}.`);
      }
    });
    cancellation?.requireActive();

    // Both sides of this now come from the same VFS, so it should be tautological. It stays as a
    // permanent assertion because a silently wrong build root is exactly what #139 was, and
    // because it is the only thing that would notice a partial or dropped write.
    if (!(await this.containerPathMatchesDurableProject(isolatedRoot))) {
      throw new Error(
        'The isolated build root does not match the durable project after being written from it, so this build ' +
          'would use stale files. Retry; if it persists the workspace container needs replacing.',
      );
    }
  }

  /**
   * Write durable bytes to a container path.
   *
   * The Sandbox write API takes a string, so the encoding has to be chosen from the bytes: text
   * goes as utf-8, and anything the strict decoder rejects goes base64 rather than being mangled
   * into replacement characters. Every container materialisation picks the same way, so the choice
   * lives here instead of at each call site.
   */
  private writeContainerFile(path: string, bytes: Uint8Array) {
    return canDecodeUtf8(bytes)
      ? this.writeFile(path, decodeUtf8(bytes), { encoding: 'utf-8' })
      : this.writeFile(path, encodeBase64(bytes), { encoding: 'base64' });
  }

  /**
   * Prove the container's own view of `/home/project` matches durable truth, once per container
   * generation.
   *
   * The isolated build roots are verified where they are copied, but the model's `exec` runs
   * against the mount directly — `cwd` defaults to `PROJECT_ROOT`. A stale mount there is the same
   * #139 failure wearing different clothes: `read` returns the new file, `pnpm run test` runs the
   * old one, and the model is told its own fix did not work.
   *
   * Keyed on the computerd process, because that is what changes when the container is replaced,
   * which is the event the divergence was observed after. Verifying per command would read the
   * whole project on every `exec`; verifying per generation costs that once and is bounded by how
   * often a container is actually replaced. An evicted Durable Object simply verifies again.
   */
  private async assertContainerMatchesDurableProject(): Promise<void> {
    const generation = (await this.processForRole(COMPUTERD_PROCESS_ROLE))?.id ?? null;
    if (generation !== null && generation === this.#verifiedContainerGeneration) {
      return;
    }
    for (const forcePush of [false, true]) {
      await this.pushDurableProjectToContainer(forcePush);
      if (await this.containerPathMatchesDurableProject(PROJECT_ROOT)) {
        this.#verifiedContainerGeneration = (await this.processForRole(COMPUTERD_PROCESS_ROLE))?.id ?? generation;
        return;
      }
      console.warn('Container project view does not match the durable project; re-materialising it', {
        forcedPush: forcePush,
      });
    }
    throw new Error(
      'The container filesystem does not match the durable project even after a forced re-push, so a command ' +
        'would run against stale files. Retry; if it persists the workspace container needs replacing.',
    );
  }

  /** One digest per side, computed the same way, so any content difference shows up as one bit. */
  private async containerPathMatchesDurableProject(isolatedRoot: string): Promise<boolean> {
    const files = await this.withComputer(readProjectFiles);
    const expected = await projectContentDigest(
      projectContentDigestInput(files, relativeProjectPath, CHECKPOINT_EXCLUDED_ROOTS),
    );
    const observed = await runTrackedSandboxCommand({
      command: sandboxShellCommand(
        isolatedContentDigestCommand({
          root: isolatedRoot,
          excludedRoots: CHECKPOINT_EXCLUDED_ROOTS,
        }),
      ),
      timeout: 2 * 60_000,
      exec: (command, options) => this.sandboxProcesses.exec(command, options),
    });
    return observed.stdout.trim() === expected;
  }

  private async pushDurableProjectToContainer(force = false): Promise<void> {
    // Computer owns durable project state and exposes it through the container's mounted /home tree. A completed
    // sync barrier plus an existing project mount is normally sufficient; another push can wait indefinitely under
    // load.
    //
    // `force` exists because that "normally" was exactly the #139 defect: after a container recycle the path exists
    // and the mount serves *stale* content, so presence proves nothing about the bytes. Only a caller that has
    // observed a divergence asks for this, because it is the expensive path.
    if (!force && (await this.exists(PROJECT_ROOT)).exists) {
      return;
    }

    // The container-side filesystem is in memory. After a container lifecycle transition, a stale Computer
    // connection can retain its sync watermark even though the native Sandbox no longer sees the FUSE mount.
    // Reconnect through a fresh computerd generation so Computer performs a full durable-to-container sync.
    // `forced` distinguishes the two reasons this runs: an absent mount, or one observed serving
    // stale bytes. Only the first is a missing project.
    console.warn('ProjectWorkspace is rematerializing the container project', { forced: force });
    await this.#workspace.close();
    await this.restartComputerd(COMPUTERD_ENV);
    await this.#workspace.push('container-shell');
    if (!(await this.exists(PROJECT_ROOT)).exists) {
      throw new Error('Cloudflare Computer could not restore the project filesystem in its execution container.');
    }
  }

  private async runTransientCommand(
    directory: string,
    command: string,
    timeout: number,
    cancellation?: ValidationCancellation,
  ): Promise<void> {
    await this.terminateTransientCommand();
    cancellation?.requireActive();
    let process: TrackedSandboxProcess | undefined;
    try {
      await runTrackedSandboxCommand({
        command: sandboxShellCommand(createContainerDirectoryCommand({ directory, command })),
        timeout,
        // Validation has no TTY. Every pnpm invocation, including the dependency-status preflight
        // that `pnpm run` performs before a script, must inherit CI mode so an incompatible modules
        // directory is replaced deterministically instead of prompting and aborting.
        exec: (trackedCommand, options) =>
          this.sandboxProcesses.exec(trackedCommand, { ...options, env: { CI: 'true' } }),
        onProcess: async (startedProcess) => {
          process = startedProcess;
          this.setProcessForRole(TRANSIENT_COMMAND_PROCESS_ROLE, startedProcess.id);
          await cancellation?.attachProcess(startedProcess);
        },
      });
    } finally {
      if (process) {
        cancellation?.detachProcess(process);
        this.clearProcessForRole(TRANSIENT_COMMAND_PROCESS_ROLE, process.id);
      }
    }
  }

  private async terminateTransientCommand(): Promise<void> {
    const existing = await this.processForRole(TRANSIENT_COMMAND_PROCESS_ROLE);
    if (existing) {
      const status = await existing.status();
      if (status.state === 'running') {
        await terminateTrackedSandboxProcess(existing);
      }
      this.clearProcessForRole(TRANSIENT_COMMAND_PROCESS_ROLE, existing.id);
    }
  }

  private async recycleWorkspaceContainer(): Promise<void> {
    await this.#workspace.close().catch((error) =>
      console.warn('Unable to close the Computer workspace before container recovery', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await Promise.race([
      this.destroy(),
      scheduler.wait(CONTAINER_RECOVERY_TIMEOUT_MS).then(() => {
        throw new Error('Timed out while recovering the ProjectWorkspace container.');
      }),
    ]);
    // Workspace.close() invalidates transport handles but intentionally retains its serialized mutation queues.
    // A fresh coordinator prevents an interrupted sync from blocking the replacement container indefinitely.
    this.#workspace = new Workspace(this.createComputerWorkspaceOptions(this.#syncRetries));
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM ghostbuild_sandbox_processes');
    });
  }

  private hasSuccessfulValidation(revision: string): boolean {
    return (
      first(
        this.ctx.storage.sql.exec<{ found: number }>(
          'SELECT 1 AS found FROM ghostbuild_validations WHERE revision = ? LIMIT 1',
          revision,
        ),
      )?.found === 1
    );
  }

  private preparedValidationArtifact(): PreparedValidationRow | null {
    return (
      first(
        this.ctx.storage.sql.exec<PreparedValidationRow>(
          `SELECT revision, workspace_revision, snapshot_root, artifact_digest
           FROM ghostbuild_prepared_validation WHERE singleton = 1`,
        ),
      ) ?? null
    );
  }

  private deploymentSessionRow(operationId: string): DeploymentSessionRow | null {
    return (
      first(
        this.ctx.storage.sql.exec<DeploymentSessionRow>(
          `SELECT operation_id, owner, idempotency_key, expected_workspace_revision,
                  expected_snapshot_revision, acquired_at, deadline, status
           FROM ghostbuild_deployment_sessions WHERE operation_id = ?`,
          operationId,
        ),
      ) ?? null
    );
  }

  private requireActiveDeploymentSession(operationId: string): DeploymentSessionRow {
    const session = this.deploymentSessionRow(operationId);
    if (!session || session.status !== 'active') {
      throw new WorkspaceOperationIndeterminateError('deployment');
    }
    return session;
  }

  private deploymentSessionLease(session: DeploymentSessionRow): WorkspaceOperationLease {
    const lease = this.#operationLane.find(session.idempotency_key, session.owner);
    if (!lease) {
      throw new WorkspaceOperationIndeterminateError('deployment');
    }
    return lease;
  }

  private currentRevision(): number {
    return first(this.ctx.storage.sql.exec<{ v: number }>("SELECT v FROM vfs_meta WHERE k = 'rev'"))?.v ?? 0;
  }

  private workspaceRow(): {
    initialized: number;
    seed_id: string | null;
    reset_revision: number;
  } {
    const row = first(
      this.ctx.storage.sql.exec<{
        initialized: number;
        seed_id: string | null;
        reset_revision: number;
      }>(
        `SELECT initialized, seed_id, reset_revision
         FROM ghostbuild_workspace_state WHERE singleton = 1`,
      ),
    );
    if (!row) {
      throw new Error('The Computer workspace state is unavailable.');
    }
    return row;
  }

  private stateFromFiles(files: WorkspaceFile[], revision = this.currentRevision()): WorkspaceState {
    const row = this.workspaceRow();
    return {
      initialized: row.initialized === 1,
      revision,
      resetRevision: row.reset_revision,
      fileCount: files.length,
      totalBytes: totalFileBytes(files),
      seeding: row.seed_id !== null,
    };
  }

  private async stableProjectRead<T>(read: (workspace: WorkspaceClient) => Promise<T>): Promise<{
    value: T;
    revision: number;
  }> {
    return stableWorkspaceRead(
      () => this.currentRevision(),
      () => this.withComputer(read),
    );
  }

  private async runToolOperation(
    toolCallId: string,
    toolName: string,
    args: unknown,
    operation: () => Promise<GhostbuildToolResult>,
  ): Promise<GhostbuildToolResult> {
    try {
      this.requireCompletedComputerSync();
    } catch (error) {
      if (error instanceof WorkspaceSyncPendingError) {
        return pendingComputerSyncToolResult(error);
      }
      throw error;
    }
    const argsJson = JSON.stringify(stableValue(args)) ?? 'null';
    const started = this.#toolOperations.begin({
      toolCallId,
      toolName,
      argsSha256: await sha256Text(argsJson),
    });
    if (started.status === 'execute') {
      this.#ownedToolOperations.add(toolCallId);
    }
    if (started.status === 'completed') {
      return requireToolResult(started.result);
    }
    if (started.status === 'failed' || started.status === 'indeterminate') {
      throw new Error(started.error);
    }
    this.#activeToolOperations.add(toolCallId);
    try {
      const result = await operation();
      return requireToolResult(this.#toolOperations.complete({ toolCallId, result }));
    } catch (error) {
      if (error instanceof WorkspaceSyncPendingError) {
        const result =
          error.commandResult && error.commandResult.exitCode !== 0
            ? toolFailure(commandFailureMessage(error.commandResult), {
                buildEnvironment: 'cloudflare-computer-container',
                nextAction: toolName === 'npmInstall' ? 'install-dependencies' : 'validate-project',
              })
            : pendingComputerSyncToolResult(error);
        this.registerPendingCommand({ backend: error.backend, toolCallId, result });
        return result;
      }
      try {
        this.#toolOperations.fail({
          toolCallId,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // A completed journal row wins if its acknowledgement was interrupted.
      }
      throw error;
    } finally {
      this.#activeToolOperations.delete(toolCallId);
      if (!this.#toolOperations.isRunning(toolCallId)) {
        this.#ownedToolOperations.delete(toolCallId);
      }
    }
  }

  private async withStatefulOperation<T>(
    kind: StatefulOperationKind,
    idempotencyKey: string,
    operation: (liveness: OperationLiveness) => Promise<T>,
    options: { resume?: boolean } = {},
  ): Promise<T> {
    this.requireCompletedComputerSync();
    const owner = crypto.randomUUID();
    const plan = operationLeasePlan(kind);
    let lease: WorkspaceOperationLease;
    try {
      lease = this.#operationLane.acquire({
        owner,
        idempotencyKey,
        kind,
        leaseMs: plan.leaseMs,
        // Re-entering this lane under its own key adopts the effect it already started; the lease
        // the dead owner still holds is protecting the workspace from a different operation.
        resume: options.resume,
      });
    } catch (error) {
      if (error instanceof WorkspaceOperationConflictError) {
        console.info('ProjectWorkspace operation lane conflict', {
          kind,
          activeKind: error.activeKind,
          retryAfterMs: error.retryAfterMs,
        });
      }
      throw error;
    }
    this.#activeOperationOwners.add(owner);
    if (lease.recoveredOwner) {
      console.info('ProjectWorkspace operation lease recovered', {
        kind,
      });
    }
    // Only lanes a model tool can occupy are renewed, and only those report
    // liveness. Every other lane keeps its lease as its single ceiling.
    const heartbeat =
      plan.silenceHorizonMs === null
        ? null
        : new OperationLeaseHeartbeat({
            lane: this.#operationLane,
            lease,
            leaseMs: plan.leaseMs,
            silenceHorizon: lease.acquiredAt + plan.silenceHorizonMs,
          });
    try {
      this.assertToolOperationRunning(toolCallIdFromOperationKey(idempotencyKey));
      const result = await this.withContainerKeepAlive(() => operation(heartbeat ?? UNWATCHED_OPERATION_LIVENESS));
      // The work finishing is not enough: if the lane stopped being ours while it
      // ran, another request was free to change the workspace underneath it.
      heartbeat?.requireHeld();
      return result;
    } finally {
      heartbeat?.stop();
      this.#operationLane.release(lease);
      this.#activeOperationOwners.delete(owner);
    }
  }

  /** Look for the execution a previous instance started, without starting or disturbing anything. */
  private async canReattachToolExecution(toolCallId: string): Promise<boolean> {
    try {
      return await this.withComputer((workspace) =>
        isExecutionReattachable(workspace.runtime, `tool:${toolCallId}`, 'container-shell'),
      );
    } catch (error) {
      console.info('ProjectWorkspace could not observe an interrupted execution', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * A journal row that is running but was not started by this instance belongs to an execution a
   * previous instance left behind. Adopting it is the only safe reading of that state: starting a
   * second command under the same key would repeat whatever the first one already did.
   */
  private resumesInterruptedExecution(toolCallId: string | null): boolean {
    return (
      toolCallId !== null && this.#toolOperations.isRunning(toolCallId) && !this.#ownedToolOperations.has(toolCallId)
    );
  }

  private assertToolOperationRunning(toolCallId: string | null): void {
    if (toolCallId) {
      this.#toolOperations.assertRunning(toolCallId);
    }
  }

  private async withContainerKeepAlive<T>(operation: () => Promise<T>): Promise<T> {
    this.#containerKeepAliveOperations += 1;
    try {
      await this.setKeepAlive(true);
      return await operation();
    } finally {
      this.#containerKeepAliveOperations -= 1;
      await this.releaseContainerKeepAliveIfIdle();
    }
  }

  private async releaseContainerKeepAliveIfIdle(): Promise<void> {
    const deploymentActive = first(
      this.ctx.storage.sql.exec<{ active: number }>(
        `SELECT 1 AS active FROM ghostbuild_deployment_sessions WHERE status = 'active' LIMIT 1`,
      ),
    );
    if (this.#containerKeepAliveOperations === 0 && !deploymentActive) {
      await this.setKeepAlive(false).catch(() => undefined);
    }
  }

  private requireCompletedComputerSync(): void {
    requireWorkspaceSyncBarrier(this.#toolOperations.pending(), (backend) => this.#syncRetries.state(backend));
  }

  private finishPendingCommand(backend: string): void {
    const continuation = this.#toolOperations.pending().find((operation) => operation.backend === backend);
    if (!continuation) {
      return;
    }
    this.#toolOperations.completePending(backend, continuation.result);
  }

  private failPendingCommand(backend: string, error: string): void {
    const continuation = this.#toolOperations.pending().find((operation) => operation.backend === backend);
    if (!continuation) {
      return;
    }
    this.#toolOperations.fail({ toolCallId: continuation.toolCallId, error });
  }

  private async recoverExhaustedComputerSync(backend: string): Promise<boolean> {
    const active = this.#activeSyncRecoveries.get(backend);
    if (active) {
      return active;
    }
    const recovery = (async () => {
      try {
        // Exhaustion may be tied to a stale Computer connection. A closed
        // Workspace reconnects lazily, so the following pull is proof from a
        // fresh backend handle rather than another attempt on the failed one.
        await this.#workspace.close();
        await this.#workspace.pull(backend);
        this.finishPendingCommand(backend);
        await this.#syncRetries.clear(backend);
        await this.cleanupReadinessRoot().catch(() => undefined);
        this.#syncRecoveryFailures.delete(backend);
        return true;
      } catch (error) {
        const failures = (this.#syncRecoveryFailures.get(backend) ?? 0) + 1;
        this.#syncRecoveryFailures.set(backend, failures);
        if (failures >= SYNC_RECOVERY_CONTAINER_RECYCLE_THRESHOLD) {
          // A fresh backend handle failed too: the container's control connection is not
          // coming back on its own. The durable VFS is untouched and the next recovery round
          // pulls into the replacement container.
          this.#syncRecoveryFailures.delete(backend);
          console.warn('ProjectWorkspace sync recovery is recycling the workspace container', {
            backend,
            failures,
            error: error instanceof Error ? error.message : String(error),
          });
          await this.recycleWorkspaceContainer().catch((recycleError) =>
            console.warn('ProjectWorkspace container recycle failed; recovery will retry', {
              backend,
              error: recycleError instanceof Error ? recycleError.message : String(recycleError),
            }),
          );
          return false;
        }
        // Not a dead end: every caller reschedules this recovery, so the
        // workspace stays blocked only until a fresh pull succeeds (#131).
        console.warn('ProjectWorkspace exhausted Computer sync recovery remains pending; recovery will retry', {
          backend,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    })();
    this.#activeSyncRecoveries.set(backend, recovery);
    try {
      return await recovery;
    } finally {
      if (this.#activeSyncRecoveries.get(backend) === recovery) {
        this.#activeSyncRecoveries.delete(backend);
      }
    }
  }

  private registerPendingCommand(args: { backend: string; toolCallId: string; result: unknown }): void {
    this.#toolOperations.registerPending(args);
    this.ctx.waitUntil(this.reconcilePendingCommands());
  }

  private async schedulePendingCommandRecovery(delayMs: number): Promise<void> {
    const delaySeconds = Math.max(1, Math.ceil(delayMs / 1_000));
    await this.scheduleOnce(delaySeconds, 'reconcilePendingCommands', {
      notBefore: Date.now() + delaySeconds * 1_000,
    });
  }

  /**
   * Deduplicating `schedule()`. `Container.schedule` mints a fresh row id on every call and then
   * `INSERT OR REPLACE`s on it, so repeated calls stack alarm rows rather than collapsing; its
   * published signature also takes no options bag, so the Durable Object runtime's `idempotent`
   * flag never reaches it. Both callbacks are whole-state sweeps that re-read persisted retry
   * state and re-derive their own next wake time when they fire, so a single pending row per
   * callback is sufficient — drop any earlier row before inserting the new one.
   */
  private async scheduleOnce(
    delaySeconds: number,
    callback: 'retryPendingComputerSync' | 'reconcilePendingCommands',
    payload: ScheduledRetryPayload,
  ): Promise<void> {
    this.deleteSchedules(callback);
    await this.schedule(delaySeconds, callback, payload);
  }

  private async cleanupReadinessRoot(): Promise<void> {
    await this.withComputer((workspace) => workspace.fs.rm(READINESS_ROOT, { recursive: true, force: true }));
  }

  private async withComputer<T>(operation: (workspace: WorkspaceClient) => Promise<T>): Promise<T> {
    const workspace = await getWorkspace(this as unknown as Parameters<typeof getWorkspace>[0]);
    try {
      return await operation(workspace);
    } finally {
      workspace[Symbol.dispose]();
    }
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const controlPlaneResponse = await routeUserWorkspaceRuntimeControlPlaneRequest(request, env);
    if (controlPlaneResponse) {
      return controlPlaneResponse;
    }
    return handleUserRequest(request, env, url, ctx);
  },
  scheduled(controller: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext): void {
    scheduleUserWorkspaceRuntimeMaintenance(controller, env, ctx);
  },
};

// The handlers below are shared with the control plane Worker, so they are typed against the global
// `Env`. `RuntimeEnv` is kept as its own explicit list so this file cannot reach for a control-plane
// binding the user-owned Worker does not have.
function sharedHandlerEnv(env: RuntimeEnv): Env {
  // SAFETY: app/user-runtime-env.d.ts declares every RuntimeEnv member on the global `Env`, and
  // app/lib/.server/cloudflare/user-account-api.ts deploys the user Worker with exactly those
  // bindings. Only PROJECT_WORKSPACE differs, and only in its Durable Object type parameter
  // (ProjectWorkspace here vs. the ProjectWorkspaceRpc view the shared handlers call through).
  return env as unknown as Env;
}

async function handleUserRequest(
  request: Request,
  env: RuntimeEnv,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') {
    return origin ? withCors(new Response(null, { status: 204 }), origin) : new Response(null, { status: 400 });
  }
  const token = bearerToken(request) ?? url.searchParams.get('capability');
  const capability = token ? await verifyRuntimeCapability(env.CONTROL_PLANE_SECRET, token, { origin }) : null;
  if (!capability || capability.subject !== env.GHOSTBUILD_USER_ID) {
    return withCors(Response.json({ error: 'Unauthorized' }, { status: 401 }), origin);
  }
  const sharedEnv = sharedHandlerEnv(env);
  let response: Response;
  const agentResponse = await routeUserRuntimeAgentRequest(request, sharedEnv, capability.subject);
  if (agentResponse) {
    response = agentResponse;
  } else if (request.method === 'GET' && url.pathname === '/v1/models') {
    try {
      const models = await readWorkersAiBuilderModelCatalog(env.AI);
      response = Response.json(workersAiModelCatalogPayload(models), {
        headers: { 'Cache-Control': 'private, max-age=300' },
      });
    } catch (error) {
      console.warn('Workers AI model catalog could not be loaded', error);
      response = Response.json({ error: 'The Workers AI model catalog is temporarily unavailable.' }, { status: 503 });
    }
  } else if (request.method === 'POST' && url.pathname === '/v1/data') {
    response = await userRuntimeDataAction({
      request,
      env: sharedEnv,
      userId: capability.subject,
      executionCtx: ctx,
    });
  } else if (request.method === 'POST' && url.pathname === '/v1/chats/messages') {
    response = await userRuntimeInitialMessagesAction({
      request,
      env: sharedEnv,
      userId: capability.subject,
    });
  } else if (request.method === 'POST' && url.pathname === '/v1/enhance-prompt') {
    response = await userRuntimeEnhancePromptAction({
      request,
      env: sharedEnv,
      userId: capability.subject,
    });
  } else {
    const deployment = /^\/v1\/deployments\/([^/]+)(?:\/(deploy))?$/.exec(url.pathname);
    if (deployment && (request.method === 'GET' || request.method === 'POST')) {
      const operation = deployment[2] === 'deploy' ? 'deploy' : 'get';
      response = await userRuntimeDeploymentAction({
        env: sharedEnv,
        userId: capability.subject,
        deploymentId: decodeURIComponent(deployment[1]!),
        operation,
      });
    } else {
      response = Response.json({ error: 'Not found' }, { status: 404 });
    }
  }
  return withCors(response, capability.origin);
}

/** The one enumeration policy - which roots are excluded and how many files may be enumerated. */
async function projectFileEntries(workspace: WorkspaceClient) {
  try {
    await workspace.fs.stat(PROJECT_ROOT);
  } catch (error) {
    if (isMissingPath(error)) {
      return [];
    }
    throw error;
  }
  const entries = (await workspace.fs.find(PROJECT_ROOT)).filter(
    (entry) =>
      entry.type === 'file' && !CHECKPOINT_EXCLUDED_ROOTS.has(relativeProjectPath(entry.path).split('/')[0] ?? ''),
  );
  if (entries.length > MAX_FILES) {
    throw new Error('The project workspace has too many files.');
  }
  return entries;
}

/** Paths only. The copy reads one file at a time, so it must not pull every byte up front. */
async function readProjectFilePaths(workspace: WorkspaceClient): Promise<string[]> {
  return (await projectFileEntries(workspace)).map((entry) => entry.path);
}

async function readProjectFiles(workspace: WorkspaceClient): Promise<WorkspaceFile[]> {
  const entries = await projectFileEntries(workspace);
  const files: WorkspaceFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const file = await readWorkspaceFile(workspace, entry.path);
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('The project workspace exceeds its size limit.');
    }
    files.push(file);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readWorkspaceFile(workspace: WorkspaceClient, path: string): Promise<WorkspaceFile> {
  const stat = await workspace.fs.stat(path);
  if (!stat.isFile || stat.size > MAX_FILE_BYTES) {
    throw new Error(`Workspace file is invalid or too large: ${path}`);
  }
  const stream = await workspace.fs.readFile(path);
  const bytes = await readStream(stream, stat.size);
  return { path, bytes, size: bytes.byteLength, mode: stat.mode, sha256: await sha256Bytes(bytes) };
}

type SandboxFileAccess = Pick<ProjectWorkspace, 'exists' | 'listFiles' | 'readFile'>;

async function collectSandboxFiles(
  sandbox: SandboxFileAccess,
  root: string,
  include: (relativePath: string) => boolean,
): Promise<DeploymentArtifactFile[]> {
  const listing = await sandbox.listFiles(root, { recursive: true, includeHidden: true });
  if (!listing.success) {
    throw new Error('The prepared deployment artifact could not be listed.');
  }
  const entries = listing.files.filter((entry) => entry.type === 'file');
  if (entries.length > MAX_DEPLOYMENT_ARTIFACT_FILES) {
    throw new Error('The prepared deployment artifact has too many files.');
  }
  const files: DeploymentArtifactFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const relativePath = relativeIsolatedPath(root, entry.absolutePath);
    if (!relativePath || !include(relativePath)) {
      continue;
    }
    if (entry.size > MAX_FILE_BYTES) {
      throw new Error(`Deployment artifact file is too large: ${relativePath}`);
    }
    const file = await sandbox.readFile(entry.absolutePath, { encoding: 'none' });
    const bytes = await readStream(file.content, file.size);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_DEPLOYMENT_ARTIFACT_BYTES) {
      throw new Error('The prepared deployment artifact exceeds its aggregate size limit.');
    }
    files.push({ path: relativePath, bytes, size: bytes.byteLength, sha256: await sha256Bytes(bytes) });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectSandboxMigrations(
  sandbox: SandboxFileAccess,
  root: string,
): Promise<Array<{ name: string; sql: string }>> {
  if (!(await sandbox.exists(root)).exists) {
    return [];
  }
  const listing = await sandbox.listFiles(root, { recursive: true, includeHidden: true });
  if (!listing.success) {
    throw new Error('Deployment migrations could not be listed.');
  }
  const migrations: Array<{ name: string; sql: string }> = [];
  for (const entry of listing.files.filter((candidate) => candidate.type === 'file')) {
    const name = requireDeploymentMigrationName(relativeIsolatedPath(root, entry.absolutePath));
    if (entry.size > MAX_FILE_BYTES) {
      throw new Error(`Deployment migration is too large: ${name}`);
    }
    const file = await sandbox.readFile(entry.absolutePath, { encoding: 'none' });
    const sql = decodeUtf8(await readStream(file.content, file.size));
    if (!sql.trim()) {
      throw new Error(`Deployment migration is empty: ${name}`);
    }
    migrations.push({ name, sql });
  }
  return migrations.sort((left, right) => left.name.localeCompare(right.name));
}

async function writeWorkspaceFile(
  workspace: WorkspaceClient,
  pathValue: unknown,
  bytes: Uint8Array,
  projectOnly = true,
): Promise<void> {
  const path = projectOnly ? requireProjectPath(pathValue) : requireAbsolutePath(pathValue);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`Workspace file exceeds ${MAX_FILE_BYTES} bytes.`);
  }
  const slash = path.lastIndexOf('/');
  await workspace.fs.mkdir(path.slice(0, slash) || '/', { recursive: true });
  await workspace.fs.writeFile(path, bytes);
}

const EXEC_STREAM_MAX_LIVE_BYTES = 1024 * 1024;
/** The model-facing half of the exec result, so it tracks the shared tool limit exactly. */
const EXEC_STREAM_RESULT_BYTES_PER_CHANNEL = COMPUTER_TOOL_LIMITS.execMaxBytesPerStream;
const MAX_CONFIRMED_COMMAND_CANCELLATIONS = 500;
const COMMAND_CANCELLATION_SETTLEMENT_TIMEOUT_MS = 35_000;
const COMMAND_CANCELLATION_RPC_TIMEOUT_MS = 5_000;

function boundCancellationAction<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${description} remained indeterminate at the cancellation deadline.`)),
      COMMAND_CANCELLATION_SETTLEMENT_TIMEOUT_MS,
    );
    void promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

function boundCancellationRpc<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${description} remained indeterminate at the RPC attempt deadline.`)),
      COMMAND_CANCELLATION_RPC_TIMEOUT_MS,
    );
    void promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

async function settleCancellationActions(actions: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(actions);
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Workspace command cancellation could not be fully confirmed.');
  }
}

type StreamCommandEvent =
  | { type: 'output'; channel: 'stdout' | 'stderr'; chunk: string }
  | { type: 'result'; result: WorkspaceRuntimeResult<'utf8'>; streamTruncated: boolean };

/**
 * Obtain the handle a command is observed through. A resumed command adopts the execution its own
 * key already has in the container and never starts a second one: if that execution cannot be
 * found the command outcome stays unknown, because repeating it is the one thing that is unsafe.
 */
async function openCommandHandle(
  workspace: WorkspaceClient,
  command: string,
  options: {
    id?: string;
    resume?: boolean;
    cwd: string;
    backend: 'container-shell';
    timeoutMs: number;
    env?: Record<string, string>;
    onSyncPending?: (result: WorkspaceRuntimeResult<'utf8'>) => void;
  },
): Promise<WorkspaceRuntimeExecHandle<'utf8'>> {
  if (options.resume) {
    if (!options.id) {
      throw new Error('A resumed workspace command requires the execution identifier it was started with.');
    }
    return reattachExecution<WorkspaceRuntimeExecHandle<'utf8'>>(workspace.runtime, options.id, options.backend);
  }
  try {
    return await workspace.runtime.exec(command, {
      id: options.id,
      cwd: options.cwd,
      backend: options.backend,
      encoding: 'utf8',
      timeoutMs: options.timeoutMs,
      env: options.env,
    });
  } catch (error) {
    if (options.id) {
      const result = await terminateWorkspaceCommand(workspace.runtime, options.id, options.backend);
      const pending = pendingWorkspaceRuntimeResult(result);
      if (pending) {
        options.onSyncPending?.(pending);
      }
    }
    throw error;
  }
}

async function streamCommand(
  workspace: WorkspaceClient,
  command: string,
  options: {
    id: string;
    resume?: boolean;
    cwd: string;
    backend: 'container-shell';
    timeoutMs: number;
    beforeExec?: () => void;
    emit: (event: StreamCommandEvent) => void;
    onHandle?: (kill: () => Promise<void>) => void;
    onSyncPending?: (result: WorkspaceRuntimeResult<'utf8'>) => void;
  },
): Promise<WorkspaceRuntimeResult<'utf8'>> {
  options.beforeExec?.();
  const handle = await openCommandHandle(workspace, command, options);
  let cancellation: Promise<void> | undefined;
  let terminationObservedPending = false;
  const terminate = () => {
    cancellation ??= terminateWorkspaceCommand(workspace.runtime, handle.id, options.backend).then((result) => {
      const pending = pendingWorkspaceRuntimeResult(result);
      if (pending) {
        terminationObservedPending = true;
        options.onSyncPending?.(pending);
      }
    });
    return cancellation;
  };
  options.onHandle?.(terminate);
  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let exitCode = -1;
  let liveBytes = 0;
  let streamTruncated = false;
  try {
    try {
      for await (const event of handle) {
        if (event.name === 'exit') {
          exitCode = event.code;
          continue;
        }
        if (event.name !== 'stdout' && event.name !== 'stderr') {
          continue;
        }
        const chunk = event.value;
        const chunkBytes = new TextEncoder().encode(chunk).byteLength;
        if (event.name === 'stdout') {
          stdoutBytes += chunkBytes;
          stdout = appendUtf8Tail(stdout, chunk, EXEC_STREAM_RESULT_BYTES_PER_CHANNEL);
        } else {
          stderrBytes += chunkBytes;
          stderr = appendUtf8Tail(stderr, chunk, EXEC_STREAM_RESULT_BYTES_PER_CHANNEL);
        }
        streamTruncated ||=
          stdoutBytes > EXEC_STREAM_RESULT_BYTES_PER_CHANNEL || stderrBytes > EXEC_STREAM_RESULT_BYTES_PER_CHANNEL;
        if (liveBytes < EXEC_STREAM_MAX_LIVE_BYTES) {
          const available = EXEC_STREAM_MAX_LIVE_BYTES - liveBytes;
          const streamedChunk = truncateUtf8Head(chunk, available);
          if (streamedChunk) {
            options.emit({ type: 'output', channel: event.name, chunk: streamedChunk });
            liveBytes += new TextEncoder().encode(streamedChunk).byteLength;
          }
          streamTruncated ||= chunkBytes > available;
        } else {
          streamTruncated = true;
        }
      }
    } catch (error) {
      // A broken event stream is not proof that the process stopped.
      await terminate();
      const pending: WorkspaceRuntimeResult<'utf8'> = {
        status: 'failed',
        exitCode,
        stdout,
        stderr,
        pushed: 0,
        pulled: 0,
        skipped: [],
        sync: {
          status: 'pending',
          applied: 0,
          skipped: [],
          error: error instanceof Error ? error.message : String(error),
        },
      };
      if (!terminationObservedPending) {
        options.onSyncPending?.(pending);
      }
      return requireDurableCommandResult(pending, options.backend);
    }

    const result: WorkspaceRuntimeResult<'utf8'> = {
      status: exitCode === 0 ? 'completed' : 'failed',
      exitCode,
      stdout,
      stderr,
      pushed: 0,
      pulled: 0,
      skipped: [],
      sync: { status: 'complete', applied: 0, skipped: [] },
    };
    options.emit({ type: 'result', result, streamTruncated });
    return result;
  } finally {
    const id = handle.id;
    try {
      await cancellation;
    } finally {
      handle[Symbol.dispose]();
      await boundCancellationRpc(
        workspace.runtime.disposeExec(id, { backend: options.backend }),
        'streamed command disposal',
      ).catch(() => undefined);
    }
  }
}

function appendUtf8Tail(current: string, chunk: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(`${current}${chunk}`);
  if (bytes.byteLength <= maxBytes) {
    return `${current}${chunk}`;
  }
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && isUtf8ContinuationByte(bytes[start]!)) {
    start += 1;
  }
  return new TextDecoder().decode(bytes.slice(start));
}

function truncateUtf8Head(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  let end = maxBytes;
  while (end > 0 && isUtf8ContinuationByte(bytes[end]!)) {
    end -= 1;
  }
  return new TextDecoder().decode(bytes.slice(0, end));
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

async function runCommand(
  workspace: WorkspaceClient,
  command: string,
  options: {
    id?: string;
    resume?: boolean;
    cwd: string;
    backend: 'container-shell';
    timeoutMs: number;
    env?: Record<string, string>;
    beforeExec?: () => void;
    onHandle?: (kill: () => Promise<void>) => void;
    onSyncPending?: (result: WorkspaceRuntimeResult<'utf8'>) => void;
  },
): Promise<WorkspaceRuntimeResult<'utf8'>> {
  options.beforeExec?.();
  const handle = await openCommandHandle(workspace, command, options);
  let cancellation: Promise<void> | undefined;
  const terminate = () => {
    cancellation ??= terminateWorkspaceCommand(workspace.runtime, handle.id, options.backend).then((result) => {
      const pending = pendingWorkspaceRuntimeResult(result);
      if (pending) {
        options.onSyncPending?.(pending);
      }
    });
    return cancellation;
  };
  options.onHandle?.(terminate);
  try {
    const result = await handle.result();
    if (result.sync.status === 'pending') {
      options.onSyncPending?.(result);
    }
    return requireDurableCommandResult(result, options.backend);
  } catch (error) {
    await terminate();
    throw error;
  } finally {
    const id = handle.id;
    try {
      await cancellation;
    } finally {
      handle[Symbol.dispose]();
      await boundCancellationRpc(
        workspace.runtime.disposeExec(id, { backend: options.backend }),
        'command disposal',
      ).catch(() => undefined);
    }
  }
}

function requireCommandSuccess(result: WorkspaceRuntimeResult<'utf8'>): void {
  if (result.exitCode !== 0) {
    throw new Error(commandFailureMessage(result));
  }
}

function commandFailureMessage(result: Pick<WorkspaceRuntimeResult<'utf8'>, 'stderr' | 'stdout'>): string {
  return `${result.stderr}\n${result.stdout}`.trim().slice(-4_000) || 'The Computer command failed.';
}

/**
 * The tool operation journal stores results as JSON, so a replayed or committed result comes back
 * untyped. Every value the journal holds for these operations was written by `runToolOperation`.
 */
function requireToolResult(value: unknown): GhostbuildToolResult {
  if (!isGhostbuildToolResult(value)) {
    throw new Error('The durable workspace tool operation did not record a tool result.');
  }
  return value;
}

function pendingComputerSyncToolResult(error: WorkspaceSyncPendingError): GhostbuildToolResult {
  return toolFailure(
    error.code === 'workspace_sync_exhausted'
      ? 'Cloudflare Computer could not confirm the durable project filesystem. The execution backend is being recovered; retry this operation.'
      : 'Cloudflare Computer is still saving the project filesystem. Retry this operation after synchronization completes.',
    {
      state: error.code,
      backend: error.backend,
      attempt: error.attempt,
      retryAfterMs: Math.max(0, error.notBefore - Date.now()),
      buildEnvironment: 'cloudflare-computer-container',
      nextAction: 'retry-operation',
      // The recorded failure names what is actually blocking the workspace —
      // e.g. an interrupted container toolchain bootstrap — instead of leaving
      // only an operator-facing log line (#131).
      ...(error.causeCode ? { cause: error.causeCode } : {}),
    },
  );
}

function fileSyncEntry(file: WorkspaceFile, revision: number) {
  const utf8 = canDecodeUtf8(file.bytes);
  return {
    kind: 'write' as const,
    path: file.path,
    content: utf8 ? decodeUtf8(file.bytes) : encodeBase64(file.bytes),
    encoding: utf8 ? ('utf8' as const) : ('base64' as const),
    size: file.size,
    sha256: file.sha256,
    revision,
  };
}

function workspaceFileMetadata(file: WorkspaceFile, revision: number) {
  return {
    path: file.path,
    encoding: canDecodeUtf8(file.bytes) ? ('utf8' as const) : ('base64' as const),
    size: file.size,
    mode: file.mode,
    sha256: file.sha256,
    revision,
  };
}

/** Placeholder identities: validation only proves the artifact builds, it binds nothing real. */
function validationDeploymentConfig(project: DeploymentProjectProfile): DeploymentConfigInput {
  const nullUuid = '00000000-0000-0000-0000-000000000000';
  const nullHexId = '00000000000000000000000000000000';
  const config: DeploymentConfigInput = {
    accountId: nullHexId,
    workerName: 'ghostbuild-validation',
    projectType: project.type,
    workersAi: project.bindings.ai,
    appAgent: project.bindings.appAgent,
  };
  if (project.bindings.d1) {
    config.d1DatabaseId = nullUuid;
    config.d1DatabaseName = 'ghostbuild-validation-db';
  }
  if (project.bindings.appAgent) {
    config.agentSecurityD1DatabaseId = nullUuid;
    config.agentSecurityD1DatabaseName = 'ghostbuild-validation-agent';
  }
  if (project.bindings.r2) {
    config.r2BucketName = 'ghostbuild-validation-storage';
  }
  if (project.bindings.kv) {
    config.kvNamespaceId = nullHexId;
  }
  return config;
}

function requireFileInputs(value: unknown): Array<{ path: string; content: string; encoding: 'utf8' | 'base64' }> {
  if (!Array.isArray(value) || value.length > SYNC_BATCH_FILES) {
    throw new SyntaxError('Invalid workspace seed entries.');
  }
  return value.map((entryValue) => {
    const entry = record(entryValue);
    return {
      path: requireProjectPath(entry.path),
      content:
        typeof entry.content === 'string' ? entry.content : requireString(entry.content, 'content', MAX_FILE_BYTES),
      encoding: requireWorkspaceFileEncoding(entry.encoding),
    };
  });
}

type WorkspaceWriteChange = {
  kind: 'write';
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  mode?: number;
};
type WorkspaceChange = { kind: 'delete'; path: string } | WorkspaceWriteChange;

function requireChanges(value: unknown): WorkspaceChange[] {
  if (!Array.isArray(value) || value.length > SYNC_BATCH_FILES) {
    throw new SyntaxError('Invalid workspace changes.');
  }
  return value.map((changeValue): WorkspaceChange => {
    const change = record(changeValue);
    const path = requireProjectPath(change.path);
    if (change.kind === 'delete') {
      return { kind: 'delete', path };
    }
    if (change.kind !== 'write' || typeof change.content !== 'string') {
      throw new SyntaxError('Invalid workspace change.');
    }
    const write: WorkspaceWriteChange = {
      kind: 'write',
      path,
      content: change.content,
      encoding: requireWorkspaceFileEncoding(change.encoding),
    };
    if (change.mode !== undefined) {
      write.mode = requireInteger(change.mode, 'mode', 0o7777);
    }
    return write;
  });
}

function requireProjectPath(value: unknown, allowRoot = false): string {
  const path = requireAbsolutePath(value);
  if ((allowRoot && path === PROJECT_ROOT) || path.startsWith(`${PROJECT_ROOT}/`)) {
    return path;
  }
  // The root stays rejected where a single file is named — reads want a file, and a change set
  // naming the root would delete or overwrite the whole project — but say so, rather than
  // claiming the project root is not under the project root.
  throw new SyntaxError(
    path === PROJECT_ROOT
      ? `${PROJECT_ROOT} is the project directory; name a path inside it.`
      : `Path must be under ${PROJECT_ROOT}.`,
  );
}

function requireAbsolutePath(value: unknown): string {
  const path = requireString(value, 'path', 1_024)
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/');
  if (!path.startsWith('/') || path.split('/').includes('..') || path.includes('\0')) {
    throw new SyntaxError('Invalid absolute workspace path.');
  }
  return path.length > 1 ? path.replace(/\/$/, '') : path;
}

function requireBackend(value: unknown): 'container-shell' {
  if (value === undefined || value === 'container-shell') {
    return 'container-shell';
  }
  throw new SyntaxError('Invalid Computer execution backend.');
}

/**
 * `terminateWorkspaceCommand` hands back whatever the Computer runtime recorded for the command it
 * killed. Only a still-pending filesystem sync is actionable, so recognise that one shape here
 * rather than at each observation site.
 */
function pendingWorkspaceRuntimeResult(value: unknown): WorkspaceRuntimeResult<'utf8'> | null {
  // SAFETY: `value` is the resolved `WorkspaceRuntimeExecHandle<'utf8'>.result()` of the killed
  // command; the sync check below rejects anything that does not carry a pending sync record.
  const result = value as WorkspaceRuntimeResult<'utf8'> | null | undefined;
  return result?.sync?.status === 'pending' ? result : null;
}

function toolCallIdFromOperationKey(operationKey: string): string | null {
  return operationKey.startsWith('tool:') ? operationKey.slice('tool:'.length) : null;
}

function failConflictedToolMutation(toolOperations: ToolOperationJournal, toolCallId: string | undefined): void {
  if (toolCallId) {
    toolOperations.fail({
      toolCallId,
      error: 'The project changed while the file mutation was starting.',
    });
  }
}

function requireRemoteToolName(value: unknown): 'write' | 'edit' | 'exec' {
  if (value === 'write' || value === 'edit' || value === 'exec') {
    return value;
  }
  throw new SyntaxError('Invalid stateful workspace tool name.');
}

function decodeFileContent(content: string, encoding: 'utf8' | 'base64'): Uint8Array {
  return encoding === 'base64' ? decodeBase64(content) : new TextEncoder().encode(content);
}

function totalFileBytes(files: WorkspaceFile[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

function relativeProjectPath(path: string): string {
  return path.slice(PROJECT_ROOT.length).replace(/^\/+/, '');
}

interface SyncCursor {
  revision: number;
  index: number;
}

function encodeSyncCursor(cursor: SyncCursor): string {
  return btoa(JSON.stringify(cursor));
}

function decodeSyncCursor(value: string): SyncCursor {
  try {
    const cursor = record(JSON.parse(atob(value)));
    return {
      revision: requireInteger(cursor.revision, 'cursor revision', Number.MAX_SAFE_INTEGER),
      index: requireInteger(cursor.index, 'cursor index', MAX_FILES),
    };
  } catch {
    throw new SyntaxError('Invalid workspace sync cursor.');
  }
}

async function readStream(stream: ReadableStream<Uint8Array>, expectedBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const result = new Uint8Array(expectedBytes);
  let offset = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (offset + value.byteLength > result.byteLength) {
      throw new Error('Workspace file changed while it was read.');
    }
    result.set(value, offset);
    offset += value.byteLength;
  }
  if (offset !== expectedBytes) {
    throw new Error('Workspace file changed while it was read.');
  }
  return result;
}

function canDecodeUtf8(bytes: Uint8Array): boolean {
  try {
    decodeUtf8(bytes);
    return !bytes.includes(0);
  } catch {
    return false;
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SyntaxError('Workspace request must be an object.');
  }
  return value;
}

/**
 * The caller may pass a stage reporter over Workers RPC, where the call is a promise rather than the
 * plain `void` its type describes. It is progress reporting for a human, so a caller that has
 * already disconnected must never fail — or delay — the validation itself.
 */
function validationStageReporter(onStage?: WorkspaceValidationStageReporter): (stage: BuilderValidationStage) => void {
  if (!onStage) {
    return () => undefined;
  }
  return (stage) => {
    try {
      void Promise.resolve(onStage(stage)).catch(() => undefined);
    } catch {
      // A disconnected caller is not a validation failure.
    }
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return value;
}

function requireOptionalString(value: unknown, name: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : requireString(value, name, maxLength);
}

function requireStringArray(value: unknown, name: string, maxLength: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxLength ||
    !value.every((item): item is string => typeof item === 'string')
  ) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return value;
}

function requireInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return value;
}

function requireCloudflareName(value: unknown, name: string): string {
  const result = requireString(value, name, 64);
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(result)) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return result;
}

function requireSnapshotRevision(value: unknown): string {
  const revision = requireString(value, 'expectedSnapshotRevision', 64);
  if (!/^[a-f0-9]{64}$/.test(revision)) {
    throw new SyntaxError('Invalid expectedSnapshotRevision.');
  }
  return revision;
}

function assertDeploymentSessionIdentity(
  session: DeploymentSessionRow,
  expectedWorkspaceRevision: number,
  expectedSnapshotRevision: string,
): void {
  if (
    session.expected_workspace_revision !== expectedWorkspaceRevision ||
    session.expected_snapshot_revision !== expectedSnapshotRevision
  ) {
    throw new Error('A deployment operation identifier was reused for a different workspace revision.');
  }
}

function sandboxShellCommand(command: string): SandboxCommand {
  return ['/bin/bash', '-lc', command];
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(value).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

function isMissingPath(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  if (error.code === 'ENOENT') {
    return true;
  }
  return typeof error.message === 'string' && /ENOENT|no such path/i.test(error.message);
}

export { BuilderAgent };
