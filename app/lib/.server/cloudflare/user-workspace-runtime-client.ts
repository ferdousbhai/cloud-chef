import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import { abortableSleep } from '~/lib/abortable-sleep';
import {
  computerSyncUnconfirmedError,
  isComputerSyncUnconfirmedError,
  workspaceOperationConflict,
  WORKSPACE_OPERATION_CONFLICT_ERROR_CODE,
} from 'cloudchef-agent/cloudflare-computer';
import {
  WorkspaceToolOperationIndeterminateError,
  type BuilderWorkspaceApi,
  type BuilderWorkspaceCheckpoint,
  type BuilderWorkspaceFileMetadata,
  type BuilderWorkspaceGitRepository,
  type ProjectWorkspaceRpc,
  type ToolOperationBeginRequest,
  type ToolOperationStartResult,
  type WorkspaceApplyChangesRequest,
  type WorkspaceCommandProgress,
  type WorkspaceCommandRequest,
  type WorkspaceCommandResult,
  type WorkspaceSearchRequest,
  type WorkspaceSeedExpectation,
  type WorkspaceSyncPageRequest,
  type WorkspaceValidationStageReporter,
} from '~/agents/builder-workspace-api';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceFileInput,
  BuilderWorkspaceLinkedProject,
  BuilderWorkspaceSeedStartResult,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from '@cloudchef/user-workspace-runtime/protocol';
import { isRetryableDurableObjectError } from '~/lib/cloudflare/durable-object-rpc.server';
import { z } from 'zod';
import { isMutationReceipt } from '@cloudchef/user-workspace-runtime/mutation-receipt';
import { stableJson } from '~/lib/stable-json';
import type { RefUpdate } from '~/lib/.server/cloudflare/git-proxy';
type ProjectWorkspaceStub = DurableObjectStub<ProjectWorkspaceRpc>;

/** Sent after a command's result when it left the project over its limits. */
const workspaceLimitsEventSchema = z.object({ type: z.literal('workspace-limits'), message: z.string() });

/** Carries the POSIX `ENOENT` code the Computer filesystem contract expects for a missing path. */
class WorkspaceFileNotFoundError extends Error {
  readonly code = 'ENOENT';

  constructor(path: string) {
    super(`ENOENT: no such file: ${path}`);
  }
}

/** Typed in-process facade over the co-deployed ProjectWorkspace Durable Object. */
export class UserWorkspaceRuntimeClient implements BuilderWorkspaceApi {
  readonly #inFlight = new Map<string, { toolName: string; argsJson: string; promise: Promise<unknown> }>();
  readonly #executionCancellations = new Map<string, Promise<void>>();
  #state: BuilderWorkspaceState | null = null;
  #files: BuilderWorkspaceFileMetadata[] = [];
  /** Whether `#files` holds a snapshot; seeding and sync pages set `#state` without one. */
  #filesLoaded = false;
  /**
   * Bumped whenever a shell command may have changed files behind the cache's back; a refresh
   * clears it only if no command ran meanwhile, so a later write never bases itself on the
   * revision from before that command.
   */
  #commandGeneration = 0;
  #refreshedGeneration = 0;
  #stubPromise: Promise<ProjectWorkspaceStub> | null = null;
  #activeTool: { toolCallId: string; toolName: string; abortSignal?: AbortSignal } | null = null;
  #activeValidationToolCallId: string | null = null;

  readonly computer: BuilderWorkspaceApi['computer'] = {
    fs: {
      stat: async (path) => {
        const file = (await this.#loadedFiles()).find((candidate) => candidate.path === path);
        if (!file) {
          throw new WorkspaceFileNotFoundError(path);
        }
        return {
          size: file.size,
          mtime: file.revision,
          mode: file.mode,
          isFile: true,
          isDirectory: false,
        };
      },
      readFile: async (path) => (await this.#stub()).streamWorkspaceFile(path),
      writeFile: async (path, content, options) => {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
        const result = await this.applyClientChanges(
          this.#attributeToActiveTool({
            baseRevision: (await this.#loadedState()).revision,
            changes: [{ kind: 'write', path, content: text, mode: options?.mode }],
          }),
        );
        if (!result.ok) {
          throw new Error('The project changed while the file was being written. Retry the operation.');
        }
      },
      mkdir: async (path) => {
        await (await this.#stub()).makeDirectory(path);
        await this.refresh();
      },
      rm: async (path) => {
        const result = await this.applyClientChanges(
          this.#attributeToActiveTool({
            baseRevision: (await this.#loadedState()).revision,
            changes: [{ kind: 'delete', path }],
          }),
        );
        if (!result.ok) {
          throw new Error('The project changed while the path was being removed. Retry the operation.');
        }
      },
      readdir: async (path) => (await this.#stub()).readDirectory(path),
      // Computer's grep and find: `grep` is a literal content search (`searchProjectFiles`), and
      // `find` filters the known file list rather than walking the tree.
      grep: async (pattern, path, options) => {
        const result = await this.searchProjectFiles({ pattern, path, ignoreCase: options?.ignoreCase });
        return result.matches.map((match) => ({ path: match.path, line: match.line, text: match.text }));
      },
      find: async (directory, pattern, options) => {
        const prefix = directory === '' || directory.endsWith('/') ? directory : `${directory}/`;
        const offset = options?.offset ?? 0;
        return (await this.#loadedFiles())
          .filter((file) => prefix === '' || file.path === directory || file.path.startsWith(prefix))
          .filter((file) => pattern === undefined || file.path.includes(pattern))
          .slice(offset, options?.limit === undefined ? undefined : offset + options.limit)
          .map((file) => ({ path: file.path, type: 'file' as const }));
      },
    },
    runtime: {
      exec: async (command, options) => ({
        result: async () => {
          const request: WorkspaceCommandRequest = { command, cwd: options.cwd, backend: options.backend };
          if (this.#activeTool) {
            request.operationKey = `tool:${this.#activeTool.toolCallId}`;
          }
          try {
            return await (await this.#stub()).execute(request);
          } finally {
            this.#invalidateAfterCommand();
          }
        },
      }),
    },
  };

  /**
   * @param getProjectId the workspace's project, read when it is first needed: its agent learns which
   *   chat it belongs to only after it is constructed.
   */
  constructor(
    private readonly env: Env,
    private readonly getProjectId: () => string,
    private readonly getUserId: () => string | null,
    /** The agent using this workspace, named on each of its commands so a change asked for there is approved in its chat. */
    private readonly getAgentName: () => string | null = () => null,
  ) {}

  get projectId(): string {
    return this.getProjectId();
  }

  /** Attribute a mutation to the running tool call so a retry of that call reuses its journal row. */
  #attributeToActiveTool(request: WorkspaceApplyChangesRequest): WorkspaceApplyChangesRequest {
    if (!this.#activeTool) {
      return request;
    }
    return {
      ...request,
      operationKey: `tool:${this.#activeTool.toolCallId}`,
      toolCallId: this.#activeTool.toolCallId,
    };
  }

  /** Best-effort container pre-start; a failure here leaves the ordinary lazy path intact. */
  async warmContainer(): Promise<void> {
    await (await this.#stub()).warmContainer();
  }

  async refresh(): Promise<BuilderWorkspaceState> {
    const generation = this.#commandGeneration;
    const stub = await this.#stub();
    const snapshot = await stub.getWorkspaceSnapshot();
    this.#state = snapshot.state;
    this.#files = snapshot.files;
    this.#filesLoaded = true;
    this.#refreshedGeneration = Math.max(this.#refreshedGeneration, generation);
    return snapshot.state;
  }

  /**
   * The cached state, read from the workspace first when this client has none yet or a command
   * has run since it was read.
   *
   * A Builder Agent that restarted (eviction, a runtime upgrade, a recovered turn) builds a fresh
   * client, and its first file mutation may come before anything has refreshed it. A command
   * (a formatter, a patch script, an install) commits its file changes as a new revision the
   * cache never saw, so the next write would otherwise fail once as a conflict. Any other stale
   * cache is left alone: the workspace rejects a write against an old revision as a conflict, and
   * the edit tool's content hash still rejects an edit made against an outdated read.
   */
  async #loadedState(): Promise<BuilderWorkspaceState> {
    return this.#state && !this.#changedByCommand() ? this.#state : this.refresh();
  }

  /** The cached file list, read from the workspace first when this client has not loaded one or a command has run since. */
  async #loadedFiles(): Promise<BuilderWorkspaceFileMetadata[]> {
    if (!this.#filesLoaded || this.#changedByCommand()) {
      await this.refresh();
    }
    return this.#files;
  }

  #changedByCommand(): boolean {
    return this.#refreshedGeneration < this.#commandGeneration;
  }

  /** A command may have changed any file, however it ended; the next mutation reads the workspace first. */
  #invalidateAfterCommand(): void {
    this.#commandGeneration += 1;
  }

  getState(): BuilderWorkspaceState {
    if (!this.#state) {
      throw new Error('The user-owned project workspace has not been loaded.');
    }
    return this.#state;
  }

  async beginSeed(seedId: string): Promise<BuilderWorkspaceSeedStartResult> {
    const result = await (await this.#stub()).beginSeed(seedId);
    this.#state = result.state;
    return result;
  }

  async appendSeed(seedId: string, entries: BuilderWorkspaceFileInput[]): Promise<BuilderWorkspaceState> {
    return this.#setState(await (await this.#stub()).appendSeed(seedId, entries));
  }

  async commitSeed(seedId: string, expected: WorkspaceSeedExpectation): Promise<BuilderWorkspaceState> {
    const state = this.#setState(await (await this.#stub()).commitSeed(seedId, expected));
    await this.refresh();
    return state;
  }

  async abortSeed(seedId: string): Promise<BuilderWorkspaceState> {
    return this.#setState(await (await this.#stub()).abortSeed(seedId));
  }

  async applyClientChanges(value: WorkspaceApplyChangesRequest): Promise<BuilderWorkspaceApplyResult> {
    const result = await (await this.#stub()).applyChanges(value);
    this.#state = result.state;
    if (result.ok && result.changedPaths.length > 0) {
      await this.refresh();
    }
    return result;
  }

  async getSyncPage(value: WorkspaceSyncPageRequest): Promise<BuilderWorkspaceSyncPage> {
    const page = await (await this.#stub()).getSyncPage(value);
    this.#state = page.state;
    return page;
  }

  async readText(path: string, abortSignal?: AbortSignal) {
    abortSignal?.throwIfAborted();
    try {
      return await raceAgainstAbort(
        this.#stub().then((stub) => {
          abortSignal?.throwIfAborted();
          return stub.readText(path);
        }),
        abortSignal,
      );
    } catch (error) {
      if (abortSignal?.aborted) {
        this.#stubPromise = null;
      }
      throw error;
    }
  }

  readFile(path: string) {
    return this.#stub().then((stub) => stub.readWorkspaceFile(path));
  }

  listFiles(): BuilderWorkspaceFileMetadata[] {
    return this.#files.map((file) => ({ ...file }));
  }

  /**
   * A search goes straight to the workspace and is not registered as the active tool: the
   * workspace answers it from its SQLite VFS outside the operation lane, so attributing it to a
   * tool operation would journal work that has nothing to replay and nothing to reattach.
   */
  searchProjectFiles(request: WorkspaceSearchRequest, abortSignal?: AbortSignal) {
    return raceAgainstAbort(
      this.#stub().then((stub) => stub.searchProjectFiles(request)),
      abortSignal,
    );
  }

  checkpoint(): Promise<BuilderWorkspaceCheckpoint> {
    return this.#stub().then((stub) => stub.checkpoint());
  }

  async executeCommand(
    args: WorkspaceCommandRequest & {
      onUpdate?: (partialResult: WorkspaceCommandProgress) => void;
      abortSignal?: AbortSignal;
    },
  ): Promise<WorkspaceCommandResult & { streamTruncated?: boolean; workspaceLimits?: string }> {
    args.abortSignal?.throwIfAborted();
    const operationKey = this.#activeTool ? `tool:${this.#activeTool.toolCallId}` : undefined;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      if (operationKey) {
        cancellation ??= this.#cancelExecutionUntilSettled(operationKey);
        void cancellation.catch(() => undefined);
      }
    };
    args.abortSignal?.addEventListener('abort', cancel, { once: true });
    const streamRequest: WorkspaceCommandRequest = { command: args.command, cwd: args.cwd, backend: args.backend };
    if (operationKey) {
      streamRequest.operationKey = operationKey;
      const agentName = this.getAgentName();
      if (agentName) {
        streamRequest.agentName = agentName;
      }
    }
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await raceAgainstAbort(
        this.#stub().then((stub) => stub.executeStream(streamRequest)),
        args.abortSignal,
      );
    } catch (error) {
      this.#invalidateAfterCommand();
      args.abortSignal?.removeEventListener('abort', cancel);
      if (args.abortSignal?.aborted) {
        cancel();
        await cancellation;
      }
      if (isRpcStreamDisconnect(error)) {
        throw workspaceCommandDisconnectError(error);
      }
      throw error;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stdout = '';
    let stderr = '';
    let finalResult:
      | { exitCode: number; stdout: string; stderr: string; streamTruncated?: boolean; workspaceLimits?: string }
      | undefined;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let lastUpdateAt = 0;
    const emitUpdate = () => {
      updateTimer = undefined;
      if (args.abortSignal?.aborted) {
        return;
      }
      lastUpdateAt = Date.now();
      args.onUpdate?.({
        command: args.command,
        cwd: args.cwd ?? null,
        backend: args.backend ?? 'container-shell',
        stdout,
        stderr,
        running: true,
      });
    };
    const scheduleUpdate = () => {
      if (!args.onUpdate) {
        return;
      }
      const delay = 100 - (Date.now() - lastUpdateAt);
      if (delay <= 0) {
        emitUpdate();
      } else {
        updateTimer ??= setTimeout(emitUpdate, delay);
      }
    };
    try {
      while (true) {
        if (finalResult && args.abortSignal?.aborted) {
          // The command has exited and reported; a stop landing before the stream closes is too late.
          return finalResult;
        }
        args.abortSignal?.throwIfAborted();
        const { done, value } = await raceAgainstAbort(reader.read(), args.abortSignal);
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line) {
            const event: unknown = JSON.parse(line);
            const command = commandEventSchema.safeParse(event);
            if (command.data?.type === 'output') {
              if (command.data.channel === 'stdout') {
                stdout = appendOutputTail(stdout, command.data.chunk);
              } else {
                stderr = appendOutputTail(stderr, command.data.chunk);
              }
              scheduleUpdate();
            } else if (command.data?.type === 'result') {
              finalResult = { ...command.data.result };
              if (command.data.streamTruncated) {
                finalResult.streamTruncated = true;
              }
            } else if (finalResult) {
              const limits = workspaceLimitsEventSchema.safeParse(event);
              if (limits.success) {
                finalResult.workspaceLimits = limits.data.message;
              }
            }
          }
          newline = buffer.indexOf('\n');
        }
      }
      if (!finalResult) {
        throw new Error('The command stream ended without a final result.');
      }
      return finalResult;
    } catch (error) {
      if (finalResult && args.abortSignal?.aborted) {
        return finalResult;
      }
      if (args.abortSignal?.aborted) {
        cancel();
        await cancellation;
      }
      if (isDurableObjectTransportReset(error)) {
        this.#stubPromise = null;
      }
      if (isRpcStreamDisconnect(error)) {
        throw workspaceCommandDisconnectError(error);
      }
      throw error;
    } finally {
      this.#invalidateAfterCommand();
      if (updateTimer) {
        clearTimeout(updateTimer);
      }
      args.abortSignal?.removeEventListener('abort', cancel);
      if (args.abortSignal?.aborted) {
        this.#stubPromise = null;
      }
      reader.releaseLock();
    }
  }

  async executeToolOnce<T>(
    toolCallIdValue: unknown,
    toolName: string,
    args: unknown,
    execute: () => Promise<T>,
    abortSignal?: AbortSignal,
  ) {
    abortSignal?.throwIfAborted();
    const toolCallId = requireToolCallId(toolCallIdValue);
    const argsJson = stableJson(args) ?? 'null';
    const existing = this.#inFlight.get(toolCallId);
    if (existing) {
      if (existing.toolName !== toolName || existing.argsJson !== argsJson) {
        throw new Error('A workspace tool-call identifier was reused with different arguments.');
      }
      const result = journaledResult<T>(await existing.promise);
      abortSignal?.throwIfAborted();
      return result;
    }
    const promise = this.#executeTool<T>(toolCallId, toolName, argsJson, execute, abortSignal);
    this.#inFlight.set(toolCallId, { toolName, argsJson, promise });
    try {
      return await promise;
    } finally {
      this.#inFlight.delete(toolCallId);
    }
  }

  async installDependencies(args: {
    toolCallId: string;
    input: unknown;
    mode: 'add' | 'sync-lockfile';
    packages: string[];
    abortSignal?: AbortSignal;
  }): Promise<CloudChefToolResult> {
    const { abortSignal, ...input } = args;
    abortSignal?.throwIfAborted();
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= settleCancellationActions('dependency installation cancellation', [
        this.#cancelExecutionUntilSettled(`tool:${args.toolCallId}`),
        this.#terminalizeToolOperationAfterExecution(
          args.toolCallId,
          'The workspace tool operation was cancelled after its execution settled.',
        ),
      ]);
      void cancellation.catch(() => undefined);
    };
    abortSignal?.addEventListener('abort', cancel, { once: true });
    try {
      return await raceAgainstAbort(
        this.#stub().then(async (stub) => {
          const result = await stub.installDependenciesTool(input);
          // Installation may have committed before cancellation; refresh before surfacing it.
          await this.refresh();
          return result;
        }),
        abortSignal,
      );
    } finally {
      abortSignal?.removeEventListener('abort', cancel);
      if (abortSignal?.aborted) {
        cancel();
        try {
          await cancellation;
        } finally {
          // The installation may have committed before it stopped. The abandoned call above would
          // refresh only when its RPC returns; the revision this call leaves behind must show it now.
          await this.refresh().catch(() => undefined);
        }
      }
    }
  }

  async validate(args: {
    toolCallId: string;
    input: unknown;
    abortSignal?: AbortSignal;
    onStage?: WorkspaceValidationStageReporter;
  }): Promise<CloudChefToolResult> {
    args.abortSignal?.throwIfAborted();
    if (this.#activeValidationToolCallId && this.#activeValidationToolCallId !== args.toolCallId) {
      throw new Error('ProjectWorkspace validation is already running.');
    }
    this.#activeValidationToolCallId = args.toolCallId;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= this.#cancelValidation(args.toolCallId);
      void cancellation.catch(() => undefined);
    };
    args.abortSignal?.addEventListener('abort', cancel, { once: true });
    try {
      return await raceAgainstAbort(
        this.#stub().then((stub) =>
          stub.validateTool({ toolCallId: args.toolCallId, input: args.input }, args.onStage),
        ),
        args.abortSignal,
      );
    } finally {
      args.abortSignal?.removeEventListener('abort', cancel);
      try {
        if (args.abortSignal?.aborted) {
          cancel();
          await cancellation;
        }
      } finally {
        if (this.#activeValidationToolCallId === args.toolCallId) {
          this.#activeValidationToolCallId = null;
        }
      }
    }
  }

  async cancelActiveValidation(): Promise<void> {
    // None known here when the ConversationAgent restarted while ProjectWorkspace still owns the validation.
    await this.#cancelValidation(this.#activeValidationToolCallId ?? undefined);
  }

  /**
   * Retries `attempt` until it returns the settled outcome (anything but undefined) or the overall
   * deadline passes. A non-retryable failure and an exhausted deadline both surface as an indeterminate
   * settlement, so the caller never mistakes an unknown outcome for a settled one; a stop ends the wait
   * with its own reason.
   */
  async #settleWithRetries<T>(
    description: string,
    attempt: (deadline: number) => Promise<T | undefined>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    const deadline = Date.now() + SETTLEMENT_OVERALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const settled = await raceAgainstAbort(attempt(deadline), abortSignal);
        if (settled !== undefined) {
          return settled;
        }
      } catch (error) {
        if (abortSignal?.aborted) {
          throw error;
        }
        if (!isRetryableSettlementError(error)) {
          throw indeterminateSettlementError(description, error);
        }
      }
      if (Date.now() >= deadline) {
        break;
      }
      await raceAgainstAbort(
        abortableSleep(Math.min(SETTLEMENT_RETRY_DELAY_MS, deadline - Date.now()), abortSignal),
        abortSignal,
      );
    }
    throw indeterminateSettlementError(description, new SettlementDeadlineError());
  }

  #cancelValidation(toolCallId?: string): Promise<void> {
    return this.#cancelUntilAnswered('workspace validation cancellation', () =>
      this.#stub().then((stub) => stub.cancelValidation(toolCallId ? { toolCallId } : {})),
    );
  }

  /** Retry a cancellation RPC until the workspace answers it. */
  async #cancelUntilAnswered<T>(description: string, cancel: () => Promise<T>): Promise<void> {
    await this.#settleWithRetries(description, async (deadline) => {
      await this.#settlementRpcAttempt(cancel, deadline, description);
      return true;
    });
  }

  #cancelExecutionUntilSettled(operationKey: string): Promise<void> {
    const existing = this.#executionCancellations.get(operationKey);
    if (existing) {
      return existing;
    }
    const cancellation = this.#cancelUntilAnswered('workspace command cancellation', () =>
      this.#stub().then((stub) => stub.cancelExecution({ operationKey })),
    ).finally(() => {
      if (this.#executionCancellations.get(operationKey) === cancellation) {
        this.#executionCancellations.delete(operationKey);
      }
    });
    this.#executionCancellations.set(operationKey, cancellation);
    return cancellation;
  }

  async #terminalizeToolOperationAfterExecution(toolCallId: string, error: string): Promise<void> {
    const description = 'workspace tool settlement';
    await this.#settleWithRetries(description, async (deadline) => {
      const result = await this.#settlementRpcAttempt(
        () => this.#stub().then((stub) => stub.cancelToolOperation({ toolCallId, error })),
        deadline,
        description,
      );
      return result.status === 'settled' || undefined;
    });
  }

  async #settlementRpcAttempt<T>(operation: () => Promise<T>, deadline: number, description: string): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SettlementDeadlineError();
    }
    try {
      return await raceAgainstTimeout(
        operation(),
        Math.min(SETTLEMENT_RPC_ATTEMPT_TIMEOUT_MS, remaining),
        () => new SettlementAttemptTimeoutError(description),
      );
    } catch (error) {
      if (error instanceof SettlementAttemptTimeoutError) {
        this.#stubPromise = null;
      }
      throw error;
    }
  }

  async setLinkedProject(value: BuilderWorkspaceLinkedProject): Promise<void> {
    await (await this.#stub()).setLinkedProject(value);
  }

  async linkedProject(): Promise<BuilderWorkspaceLinkedProject | null> {
    return (await this.#stub()).linkedProject();
  }

  async setGitRepository(value: BuilderWorkspaceGitRepository): Promise<void> {
    await (await this.#stub()).setGitRepository(value);
  }

  async takeGitPushes(): Promise<RefUpdate[]> {
    return (await this.#stub()).takeGitPushes();
  }

  async knownMain(): Promise<string | null> {
    return (await this.#stub()).knownMain();
  }

  hasSuccessfulValidation(revision: string): Promise<boolean> {
    return this.#stub()
      .then((stub) => stub.validationStatus(revision))
      .then((result) => result.valid);
  }

  prepareDeployment(revision: string): ReturnType<BuilderWorkspaceApi['prepareDeployment']> {
    return this.#stub().then((stub) => stub.deploymentPlan(revision));
  }

  async deleteProject(): Promise<void> {
    await (await this.#stub()).deleteProject();
    this.#state = null;
    this.#files = [];
    this.#filesLoaded = false;
  }

  async #executeTool<T>(
    toolCallId: string,
    toolName: string,
    argsJson: string,
    execute: () => Promise<T>,
    abortSignal?: AbortSignal,
  ) {
    abortSignal?.throwIfAborted();
    let stub: ProjectWorkspaceStub;
    let started: ToolOperationStartResult;
    try {
      stub = await raceAgainstAbort(this.#stub(), abortSignal);
      started = await raceAgainstAbort(beginToolOperation(stub, { toolCallId, toolName, argsJson }), abortSignal);
    } catch (error) {
      if (abortSignal?.aborted) {
        await this.#terminalizeToolOperationAfterExecution(
          toolCallId,
          'The workspace tool operation was cancelled before execution started.',
        );
      }
      throw error;
    }
    if (started.status === 'active') {
      try {
        // Another execution of this call is running: wait for its outcome rather than run it again.
        const description = 'active workspace tool replay observation';
        started = await this.#settleWithRetries(
          description,
          async (deadline) => {
            const replay = await this.#settlementRpcAttempt(
              () => this.#stub().then((current) => beginToolOperation(current, { toolCallId, toolName, argsJson })),
              deadline,
              description,
            );
            if (replay.status === 'execute') {
              throw new Error('An active workspace tool replay unexpectedly lost its durable journal row.');
            }
            return replay.status === 'active' ? undefined : replay;
          },
          abortSignal,
        );
      } catch (error) {
        if (abortSignal?.aborted) {
          await this.#cancelStartedToolOperation(
            toolCallId,
            toolName,
            'The active workspace tool replay was cancelled.',
          );
        }
        throw error;
      }
    }
    if (started.status === 'completed') {
      if (isPendingMutationReceipt(started.result)) {
        return journaledResult<T>(
          await raceAgainstAbort(stub.completeToolOperation({ toolCallId, result: started.result }), abortSignal),
        );
      }
      return journaledResult<T>(started.result);
    }
    if (started.status === 'failed') {
      throw new Error(started.error);
    }
    if (started.status === 'indeterminate') {
      throw new WorkspaceToolOperationIndeterminateError(started.error);
    }
    if (this.#activeTool) {
      // beginToolOperation already opened a durable `running` row; settle it before throwing so the
      // guard cannot leak a row that counts against the journal's indeterminate-operation ceiling.
      const serializationError = 'ProjectWorkspace tools are serialized; a second mutation cannot start concurrently.';
      await stub.failToolOperation({ toolCallId, error: serializationError }).catch(() => undefined);
      throw new Error(serializationError);
    }
    this.#activeTool = { toolCallId, toolName, abortSignal };
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= this.#cancelStartedToolOperation(
        toolCallId,
        toolName,
        'The workspace tool operation was cancelled after its execution settled.',
      );
      void cancellation.catch(() => undefined);
    };
    abortSignal?.addEventListener('abort', cancel, { once: true });
    if (abortSignal?.aborted) {
      cancel();
    }
    try {
      abortSignal?.throwIfAborted();
      const result = await execute();
      const syncError = computerSyncUnconfirmedError(result);
      if (syncError) {
        throw syncError;
      }
      if (abortSignal?.aborted) {
        // The tool finished before it saw its stop (a write's receipt is already committed, a command
        // has exited), so its result is the outcome; the stop only settles the journal row behind it,
        // and a failure settling that row doesn't make the known result indeterminate.
        cancel();
        await cancellation?.catch(() => undefined);
        return result;
      }
      // From here the tool has landed, so its acknowledgement is not raced against a stop: a stop
      // arriving now only settles the journal row behind the result.
      try {
        const completed = await stub.completeToolOperation({ toolCallId, result });
        await cancellation?.catch(() => undefined);
        const committedFileMutation =
          (toolName === 'write' || toolName === 'edit') &&
          isComputerToolError(result) &&
          isCompletedMutationReceipt(completed);
        return journaledResult<T>(committedFileMutation ? completed : result);
      } catch (error) {
        if (abortSignal?.aborted) {
          cancel();
          await cancellation?.catch(() => undefined);
          return result;
        }
        if (toolName !== 'write' && toolName !== 'edit') {
          throw error;
        }
        if (!isRetryableDurableObjectError(error)) {
          throw error;
        }
        const replay = await beginToolOperation(stub, { toolCallId, toolName, argsJson });
        if (replay.status !== 'completed') {
          throw error;
        }
        const completed = isPendingMutationReceipt(replay.result)
          ? await stub.completeToolOperation({ toolCallId, result })
          : replay.result;
        return journaledResult<T>(
          isComputerToolError(result) && isCompletedMutationReceipt(completed) ? completed : result,
        );
      }
    } catch (error) {
      if (abortSignal?.aborted) {
        cancel();
        await cancellation;
      } else if (!isComputerSyncUnconfirmedError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        await this.#terminalizeToolOperationAfterExecution(toolCallId, message);
      }
      throw error;
    } finally {
      abortSignal?.removeEventListener('abort', cancel);
      this.#activeTool = null;
    }
  }

  #cancelStartedToolOperation(toolCallId: string, toolName: string, error: string): Promise<void> {
    const terminalize = this.#terminalizeToolOperationAfterExecution(toolCallId, error);
    return toolName === 'exec'
      ? settleCancellationActions('workspace command and journal cancellation', [
          this.#cancelExecutionUntilSettled(`tool:${toolCallId}`),
          terminalize,
        ])
      : terminalize;
  }

  #setState(value: BuilderWorkspaceState): BuilderWorkspaceState {
    this.#state = value;
    return value;
  }

  async #stub(): Promise<ProjectWorkspaceStub> {
    if (this.#stubPromise) {
      return this.#stubPromise;
    }
    const promise = this.#resolveStub().then((stub) =>
      this.#guardStub(stub, () => {
        if (this.#stubPromise === promise) {
          this.#stubPromise = null;
        }
      }),
    );
    this.#stubPromise = promise;
    try {
      return await promise;
    } catch (error) {
      if (this.#stubPromise === promise) {
        this.#stubPromise = null;
      }
      throw error;
    }
  }

  #guardStub(stub: ProjectWorkspaceStub, invalidate: () => void): ProjectWorkspaceStub {
    type StubMethod = (...args: unknown[]) => unknown;
    const invoke = async (value: StubMethod, target: ProjectWorkspaceStub, args: unknown[]): Promise<unknown> => {
      try {
        return await Reflect.apply(value, target, args);
      } catch (error) {
        if (isDurableObjectTransportReset(error)) {
          invalidate();
        }
        throw workspaceBusyError(error) ?? error;
      }
    };
    return new Proxy(stub, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') {
          return value;
        }
        return async (...args: unknown[]) => {
          // A file change made for a tool is that tool's to stop: once it is stopped no new attempt
          // starts, so a write queued behind a busy lane cannot land after its turn was reported
          // stopped. An attempt already in flight is left to finish. Only a change attributed to the
          // tool is its to stop; the person's own editor save made meanwhile is not.
          const activeTool = this.#activeTool;
          const request = args[0];
          const abortSignal =
            property === 'applyChanges' &&
            activeTool &&
            isObject(request) &&
            'operationKey' in request &&
            request.operationKey === `tool:${activeTool.toolCallId}`
              ? activeTool.abortSignal
              : undefined;
          const startedAt = Date.now();
          let backoff = BUSY_RETRY_INITIAL_DELAY_MS;
          while (true) {
            try {
              return await invoke(value as StubMethod, target, args);
            } catch (error) {
              const wait = busyRetryWait(error);
              if (!wait || Date.now() + backoff >= startedAt + wait.windowMs) {
                throw error;
              }
              await raceAgainstAbort(abortableSleep(backoff, abortSignal), abortSignal);
              backoff = Math.min(backoff * 2, wait.maxDelayMs);
            }
          }
        };
      },
    });
  }

  async #resolveStub(): Promise<ProjectWorkspaceStub> {
    const userId = this.getUserId();
    if (!userId) {
      throw new Error('Agent authentication is required.');
    }
    if (this.env.CLOUDCHEF_USER_RUNTIME !== '1' || this.env.CLOUDCHEF_USER_ID !== userId) {
      throw new Error('The user-owned Cloudflare workspace runtime is not configured for this project owner.');
    }
    const stub = this.env.PROJECT_WORKSPACE.get(this.env.PROJECT_WORKSPACE.idFromName(this.projectId));
    await stub.initializeProjectIdentity({ projectId: this.projectId, userId });
    return stub;
  }
}

const COMMAND_UPDATE_TAIL_CHARACTERS = 64 * 1024;
const SETTLEMENT_RPC_ATTEMPT_TIMEOUT_MS = 5_000;
const SETTLEMENT_OVERALL_TIMEOUT_MS = 30_000;
const SETTLEMENT_RETRY_DELAY_MS = 1_000;

/**
 * The durable operation lane never waits inside the Durable Object, so a busy
 * workspace rejects immediately. Restate the lane's conflict as retryable
 * guidance instead of an opaque Durable Object failure.
 */
class WorkspaceBusyError extends Error {
  readonly code = WORKSPACE_OPERATION_CONFLICT_ERROR_CODE;
  readonly retryable = true;

  constructor(
    readonly activeKind: string,
    readonly retryAfterMs: number,
  ) {
    super(
      `The project workspace is busy with ${activeKind}. Retry in ${Math.max(1, Math.ceil(Math.min(retryAfterMs, BUSY_RETRY_HINT_MAX_MS) / 1_000))} seconds.`,
    );
    this.name = 'WorkspaceBusyError';
  }
}

/**
 * `ProjectWorkspaceRpc` declares `beginToolOperation(): Promise<ToolOperationStartResult>`, but the
 * Durable Object stub type rewrites a union return into one promise per member, which no longer
 * matches the declared contract at a call site.
 */
function beginToolOperation(
  stub: ProjectWorkspaceStub,
  request: ToolOperationBeginRequest,
): Promise<ToolOperationStartResult> {
  // SAFETY: restates the union `ProjectWorkspaceRpc` already guarantees for this method.
  return stub.beginToolOperation(request) as Promise<ToolOperationStartResult>;
}

/**
 * The workspace journal stores each tool call's result verbatim and hands the same payload back on
 * replay or acknowledgement, so a value read out of it is the result this call's `execute()` produced.
 */
function journaledResult<T>(value: unknown): T {
  // SAFETY: the journal round-trips this tool call's own result; see above.
  return value as T;
}

function workspaceBusyError(error: unknown): WorkspaceBusyError | null {
  const conflict = workspaceOperationConflict(error);
  return conflict ? new WorkspaceBusyError(conflict.activeKind, conflict.retryAfterMs) : null;
}

/**
 * How long a caller waits out a lane held by a fast operation before reporting it as busy.
 *
 * The model emits tool calls in batches and the Pi loop executes a batch concurrently, but the
 * workspace operation lane is an exclusive mutex that rejects rather than queues. Without this,
 * a single assistant message that writes four files lands one write and turns the other three
 * into tool errors, so the model spends four model turns — the expensive part — doing one turn's
 * work. Retrying is safe by construction: the lane rejects in `acquire()`, before the operation
 * body runs, so a conflicted call has started no effect to repeat.
 *
 * `WorkspaceBusyError.retryAfterMs` is deliberately not used as the delay. It reports when the
 * holder's *lease* lapses (15 minutes, 45 for deployment), not when its work ends, which is the
 * right answer for "when may another owner reclaim this lane" and the wrong one for "when will
 * the sibling write in this batch be done".
 */
const BUSY_RETRY_INITIAL_DELAY_MS = 25;

/**
 * Lane kinds worth waiting on, and for how long. `write` covers the batched file mutations above
 * and completes in milliseconds. `deployment` is a publication finishing up: a new turn cancels the
 * automatic one it would wait for, which then stops at its next step or, past the point where
 * stopping would leave production half changed, finishes its last API calls within a minute or so.
 * Every other kind — `exec`, `install`, `validate`, `seed`, `delete` — can legitimately hold the
 * lane for many minutes, so a caller that queued behind one would burn its whole window and still
 * fail. Those keep failing immediately, exactly as before.
 */
const BUSY_RETRY_WAITS = new Map([
  ['write', { windowMs: 10_000, maxDelayMs: 250 }],
  ['deployment', { windowMs: 90_000, maxDelayMs: 2_000 }],
]);

/**
 * The longest retry a busy error suggests. `retryAfterMs` is when the holder's lease lapses — 45
 * minutes for a deployment — which no holder that is still working takes; told that, the model
 * would give up on the workspace instead of trying again shortly.
 */
const BUSY_RETRY_HINT_MAX_MS = 60_000;

function busyRetryWait(error: unknown): { windowMs: number; maxDelayMs: number } | null {
  return error instanceof WorkspaceBusyError ? (BUSY_RETRY_WAITS.get(error.activeKind) ?? null) : null;
}

class SettlementAttemptTimeoutError extends Error {
  readonly retryable = true;

  constructor(operation: string) {
    super(`${operation} RPC attempt timed out.`);
  }
}

class SettlementDeadlineError extends Error {
  constructor() {
    super('The settlement deadline elapsed.');
  }
}

/** One line of a streamed command: a chunk of its output, or its final result. */
const commandEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), channel: z.enum(['stdout', 'stderr']), chunk: z.string() }),
  z.object({
    type: z.literal('result'),
    streamTruncated: z.boolean(),
    result: z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() }),
  }),
]);

function appendOutputTail(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length <= COMMAND_UPDATE_TAIL_CHARACTERS ? next : next.slice(-COMMAND_UPDATE_TAIL_CHARACTERS);
}

/** A committed workspace mutation whose journal row is still being settled. */
function isPendingMutationReceipt(value: unknown): boolean {
  return isMutationReceipt(value) && value.acknowledgement === 'pending';
}

/** A committed workspace mutation the Durable Object has acknowledged. */
function isCompletedMutationReceipt(value: unknown): boolean {
  return isMutationReceipt(value) && value.acknowledgement === 'complete';
}

function isComputerToolError(value: unknown): boolean {
  return isObject(value) && 'error' in value && typeof value.error === 'string';
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function requireToolCallId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error('Invalid workspace tool-call identifier.');
  }
  return value;
}

function isRpcStreamDisconnect(error: unknown): boolean {
  return errorMessage(error).includes('ReadableStream received over RPC disconnected prematurely');
}

function isDurableObjectTransportReset(error: unknown): boolean {
  return isRetryableDurableObjectError(error) || isRpcStreamDisconnect(error);
}

function workspaceCommandDisconnectError(cause: unknown): Error {
  return new Error(
    'The workspace command connection dropped before completion. The connection was reset; retry the command.',
    { cause },
  );
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message
    : '';
}

function raceAgainstAbort<T>(promise: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  if (!abortSignal) {
    return promise;
  }
  abortSignal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortSignal.reason);
    abortSignal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => abortSignal.removeEventListener('abort', abort));
  });
}

function raceAgainstTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(timeoutError()), Math.max(0, timeoutMs));
    void promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

async function settleCancellationActions(operation: string, actions: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(actions);
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length > 0) {
    throw indeterminateSettlementError(
      operation,
      new AggregateError(failures, `Unable to confirm every action required for ${operation}.`),
    );
  }
}

function isRetryableSettlementError(error: unknown): boolean {
  return error instanceof SettlementAttemptTimeoutError || isRetryableDurableObjectError(error);
}

function indeterminateSettlementError(operation: string, cause: unknown): WorkspaceToolOperationIndeterminateError {
  return new WorkspaceToolOperationIndeterminateError(
    `Unable to confirm ${operation}; the workspace operation outcome is indeterminate.`,
    { cause },
  );
}
