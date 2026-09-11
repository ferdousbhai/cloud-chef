import type { GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import {
  computerSyncUnconfirmedError,
  isComputerSyncUnconfirmedError,
  workspaceOperationConflict,
  WORKSPACE_OPERATION_CONFLICT_ERROR_CODE,
} from 'ghostbuild-agent/cloudflare-computer';
import {
  WorkspaceToolOperationIndeterminateError,
  type BuilderWorkspaceApi,
  type BuilderWorkspaceCheckpoint,
  type BuilderWorkspaceFileMetadata,
  type ProjectWorkspaceRpc,
  type ToolOperationBeginRequest,
  type ToolOperationStartResult,
  type WorkspaceApplyChangesRequest,
  type WorkspaceCommandProgress,
  type WorkspaceCommandRequest,
  type WorkspaceCommandResult,
  type WorkspaceListingRequest,
  type WorkspaceSearchRequest,
  type WorkspaceSeedExpectation,
  type WorkspaceSyncPageRequest,
  type WorkspaceValidationStageReporter,
} from '~/agents/builder-workspace-api';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceFileInput,
  BuilderWorkspaceSeedStartResult,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from '~/agents/builder-workspace-types';
import { isRetryableDurableObjectError } from '~/lib/cloudflare/durable-object-rpc.server';
type ProjectWorkspaceStub = DurableObjectStub<ProjectWorkspaceRpc>;

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
  #stubPromise: Promise<ProjectWorkspaceStub> | null = null;
  #activeTool: { toolCallId: string; toolName: string } | null = null;
  #activeValidationToolCallId: string | null = null;

  readonly computer: BuilderWorkspaceApi['computer'] = {
    fs: {
      stat: async (path) => {
        const file = this.#files.find((candidate) => candidate.path === path);
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
            baseRevision: this.getState().revision,
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
            baseRevision: this.getState().revision,
            changes: [{ kind: 'delete', path }],
          }),
        );
        if (!result.ok) {
          throw new Error('The project changed while the path was being removed. Retry the operation.');
        }
      },
      readdir: async (path) => (await this.#stub()).readDirectory(path),
      // Computer 0.2.x's fs contract added grep/find, which back the model's search tools.
      // `searchProjectFiles` is a literal content search; regex grep and directory results are not
      // yet mapped, and `find` filters the known file list rather than walking the tree. Adequate
      // for the common literal/path case; refine once the exec path is confirmed on 0.2.x.
      grep: async (pattern, path, options) => {
        const result = await this.searchProjectFiles({ pattern, path, ignoreCase: options?.ignoreCase });
        return result.matches.map((match) => ({ path: match.path, line: match.line, text: match.text }));
      },
      find: async (directory, pattern, options) => {
        const prefix = directory === '' || directory.endsWith('/') ? directory : `${directory}/`;
        const offset = options?.offset ?? 0;
        return this.#files
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
          return (await this.#stub()).execute(request);
        },
      }),
    },
  };

  constructor(
    private readonly env: Env,
    readonly projectId: string,
    private readonly getUserId: () => string | null,
  ) {}

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
    const stub = await this.#stub();
    const snapshot = await stub.getWorkspaceSnapshot();
    this.#state = snapshot.state;
    this.#files = snapshot.files;
    return snapshot.state;
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
   * Discovery goes straight to the workspace and is not registered as the active tool: the
   * workspace answers it from its SQLite VFS outside the operation lane, so attributing it to a
   * tool operation would journal work that has nothing to replay and nothing to reattach.
   */
  listProjectEntries(request: WorkspaceListingRequest, abortSignal?: AbortSignal) {
    return raceAgainstAbort(
      this.#stub().then((stub) => stub.listProjectEntries(request)),
      abortSignal,
    );
  }

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
  ): Promise<WorkspaceCommandResult & { streamTruncated?: boolean }> {
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
    }
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await raceAgainstAbort(
        this.#stub().then((stub) => stub.executeStream(streamRequest)),
        args.abortSignal,
      );
    } catch (error) {
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
    let finalResult: { exitCode: number; stdout: string; stderr: string; streamTruncated?: boolean } | undefined;
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
            if (isCommandOutputEvent(event)) {
              if (event.channel === 'stdout') {
                stdout = appendOutputTail(stdout, event.chunk);
              } else {
                stderr = appendOutputTail(stderr, event.chunk);
              }
              scheduleUpdate();
            } else if (isCommandResultEvent(event)) {
              finalResult = {
                exitCode: event.result.exitCode,
                stdout: event.result.stdout,
                stderr: event.result.stderr,
              };
              if (event.streamTruncated) {
                finalResult.streamTruncated = true;
              }
            }
          }
          newline = buffer.indexOf('\n');
        }
      }
      if (!finalResult) {
        throw new Error('The command stream ended without a final result.');
      }
      args.abortSignal?.throwIfAborted();
      return finalResult;
    } catch (error) {
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
    const argsJson = JSON.stringify(stableValue(args));
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
  }): Promise<GhostbuildToolResult> {
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
        await cancellation;
      }
    }
  }

  async validate(args: {
    toolCallId: string;
    input: unknown;
    abortSignal?: AbortSignal;
    onStage?: WorkspaceValidationStageReporter;
  }): Promise<GhostbuildToolResult> {
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
    const toolCallId = this.#activeValidationToolCallId;
    if (!toolCallId) {
      // The BuilderAgent can restart while ProjectWorkspace still owns the validation.
      await this.#cancelValidation();
      return;
    }
    await this.#cancelValidation(toolCallId);
  }

  /**
   * Retries `attempt` until it reports the operation settled or the overall deadline passes.
   * A non-retryable failure and an exhausted deadline both surface as an indeterminate
   * settlement, so the caller never mistakes an unknown outcome for a settled one.
   */
  async #settleWithRetries(description: string, attempt: (deadline: number) => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + SETTLEMENT_OVERALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        if (await attempt(deadline)) {
          return;
        }
      } catch (error) {
        if (!isRetryableSettlementError(error)) {
          throw indeterminateSettlementError(description, error);
        }
      }
      if (Date.now() >= deadline) {
        break;
      }
      await delay(Math.min(SETTLEMENT_RETRY_DELAY_MS, deadline - Date.now()));
    }
    throw indeterminateSettlementError(description, new SettlementDeadlineError());
  }

  async #cancelValidation(toolCallId?: string): Promise<void> {
    const description = 'workspace validation cancellation';
    await this.#settleWithRetries(description, async (deadline) => {
      await this.#settlementRpcAttempt(
        () => this.#stub().then((stub) => stub.cancelValidation(toolCallId ? { toolCallId } : {})),
        deadline,
        description,
      );
      return true;
    });
  }

  #cancelExecutionUntilSettled(operationKey: string): Promise<void> {
    const existing = this.#executionCancellations.get(operationKey);
    if (existing) {
      return existing;
    }
    const cancellation = this.#performExecutionCancellation(operationKey).finally(() => {
      if (this.#executionCancellations.get(operationKey) === cancellation) {
        this.#executionCancellations.delete(operationKey);
      }
    });
    this.#executionCancellations.set(operationKey, cancellation);
    return cancellation;
  }

  async #performExecutionCancellation(operationKey: string): Promise<void> {
    const description = 'workspace command cancellation';
    await this.#settleWithRetries(description, async (deadline) => {
      await this.#settlementRpcAttempt(
        () => this.#stub().then((stub) => stub.cancelExecution({ operationKey })),
        deadline,
        description,
      );
      return true;
    });
  }

  async #terminalizeToolOperationAfterExecution(toolCallId: string, error: string): Promise<void> {
    const description = 'workspace tool settlement';
    await this.#settleWithRetries(description, async (deadline) => {
      const result = await this.#settlementRpcAttempt(
        () => this.#stub().then((stub) => stub.cancelToolOperation({ toolCallId, error })),
        deadline,
        description,
      );
      return result.status === 'settled';
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
        started = await this.#pollActiveToolReplay(toolCallId, toolName, argsJson, abortSignal);
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
    this.#activeTool = { toolCallId, toolName };
    let executionStarted = false;
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
      executionStarted = true;
      const result = await execute();
      abortSignal?.throwIfAborted();
      const syncError = computerSyncUnconfirmedError(result);
      if (syncError) {
        throw syncError;
      }
      try {
        abortSignal?.throwIfAborted();
        const completed = await raceAgainstAbort(stub.completeToolOperation({ toolCallId, result }), abortSignal);
        abortSignal?.throwIfAborted();
        const committedFileMutation =
          (toolName === 'write' || toolName === 'edit') &&
          isComputerToolError(result) &&
          isCompletedMutationReceipt(completed);
        return journaledResult<T>(committedFileMutation ? completed : result);
      } catch (error) {
        abortSignal?.throwIfAborted();
        if (toolName !== 'write' && toolName !== 'edit') {
          throw error;
        }
        if (!isRetryableDurableObjectError(error)) {
          throw error;
        }
        const replay = await raceAgainstAbort(
          beginToolOperation(stub, { toolCallId, toolName, argsJson }),
          abortSignal,
        );
        if (replay.status !== 'completed') {
          throw error;
        }
        const completed = isPendingMutationReceipt(replay.result)
          ? await raceAgainstAbort(stub.completeToolOperation({ toolCallId, result }), abortSignal)
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
        if (executionStarted) {
          await this.#terminalizeToolOperationAfterExecution(toolCallId, message);
        } else {
          await stub.failToolOperation({ toolCallId, error: message }).catch(() => undefined);
        }
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

  async #pollActiveToolReplay(
    toolCallId: string,
    toolName: string,
    argsJson: string,
    abortSignal?: AbortSignal,
  ): Promise<Exclude<ToolOperationStartResult, { status: 'active' }>> {
    const deadline = Date.now() + ACTIVE_REPLAY_OVERALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await raceAgainstAbort(delay(Math.min(ACTIVE_REPLAY_RETRY_DELAY_MS, deadline - Date.now())), abortSignal);
      try {
        const replay = await raceAgainstAbort(
          this.#settlementRpcAttempt(
            () => this.#stub().then((stub) => beginToolOperation(stub, { toolCallId, toolName, argsJson })),
            deadline,
            'active workspace tool replay observation',
          ),
          abortSignal,
        );
        if (replay.status === 'active') {
          continue;
        }
        if (replay.status === 'execute') {
          throw new Error('An active workspace tool replay unexpectedly lost its durable journal row.');
        }
        return replay;
      } catch (error) {
        if (!isRetryableSettlementError(error)) {
          throw indeterminateSettlementError('active workspace tool replay observation', error);
        }
      }
    }
    throw indeterminateSettlementError('active workspace tool replay observation', new SettlementDeadlineError());
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
          const deadline = Date.now() + BUSY_RETRY_WINDOW_MS;
          let backoff = BUSY_RETRY_INITIAL_DELAY_MS;
          while (true) {
            try {
              return await invoke(value as StubMethod, target, args);
            } catch (error) {
              if (!shouldRetryWhileWorkspaceIsBusy(error) || Date.now() + backoff >= deadline) {
                throw error;
              }
              await delay(backoff);
              backoff = Math.min(backoff * 2, BUSY_RETRY_MAX_DELAY_MS);
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
    if (this.env.GHOSTBUILD_USER_RUNTIME !== '1' || this.env.GHOSTBUILD_USER_ID !== userId) {
      throw new Error('The user-owned Cloudflare workspace runtime is not configured for this project owner.');
    }
    const stub = this.env.PROJECT_WORKSPACE.get(this.env.PROJECT_WORKSPACE.idFromName(this.projectId));
    await stub.initializeProjectIdentity({ projectId: this.projectId, userId });
    return stub;
  }
}

const COMMAND_UPDATE_TAIL_CHARACTERS = 64 * 1024;
const ACTIVE_REPLAY_RETRY_DELAY_MS = 1_000;
const ACTIVE_REPLAY_OVERALL_TIMEOUT_MS = 30_000;
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
      `The project workspace is busy with ${activeKind}. Retry in ${Math.max(1, Math.ceil(retryAfterMs / 1_000))} seconds.`,
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
const BUSY_RETRY_WINDOW_MS = 10_000;
const BUSY_RETRY_INITIAL_DELAY_MS = 25;
const BUSY_RETRY_MAX_DELAY_MS = 250;

/**
 * Lane kinds worth waiting on. `write` covers the batched file mutations above and completes in
 * milliseconds. Every other kind — `exec`, `install`, `validate`, `preview`, `seed`, `delete` —
 * can legitimately hold the lane for minutes, so a caller that queued behind one would burn its
 * whole window and still fail. Those keep failing immediately, exactly as before.
 */
const BUSY_RETRY_ACTIVE_KINDS = new Set(['write']);

export function shouldRetryWhileWorkspaceIsBusy(error: unknown): boolean {
  return error instanceof WorkspaceBusyError && BUSY_RETRY_ACTIVE_KINDS.has(error.activeKind);
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

type CommandOutputEvent = { type: 'output'; channel: 'stdout' | 'stderr'; chunk: string };
type CommandResultEvent = {
  type: 'result';
  streamTruncated: boolean;
  result: { exitCode: number; stdout: string; stderr: string };
};

function isCommandOutputEvent(value: unknown): value is CommandOutputEvent {
  if (!isObject(value) || !('type' in value) || !('channel' in value) || !('chunk' in value)) {
    return false;
  }
  return (
    value.type === 'output' &&
    (value.channel === 'stdout' || value.channel === 'stderr') &&
    typeof value.chunk === 'string'
  );
}

function isCommandResultEvent(value: unknown): value is CommandResultEvent {
  if (!isObject(value) || !('type' in value) || !('result' in value) || !('streamTruncated' in value)) {
    return false;
  }
  const { result } = value;
  if (value.type !== 'result' || !isObject(result)) {
    return false;
  }
  return (
    typeof value.streamTruncated === 'boolean' &&
    'exitCode' in result &&
    typeof result.exitCode === 'number' &&
    'stdout' in result &&
    typeof result.stdout === 'string' &&
    'stderr' in result &&
    typeof result.stderr === 'string'
  );
}

function appendOutputTail(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length <= COMMAND_UPDATE_TAIL_CHARACTERS ? next : next.slice(-COMMAND_UPDATE_TAIL_CHARACTERS);
}

/**
 * A committed workspace mutation the Durable Object acknowledges, either while the journal row is
 * still being settled (`pending`) or once it has been (`complete`).
 */
function isMutationReceipt(value: unknown, acknowledgement: 'pending' | 'complete'): boolean {
  return (
    isObject(value) &&
    'kind' in value &&
    value.kind === 'workspace-mutation-receipt' &&
    'committed' in value &&
    value.committed === true &&
    'acknowledgement' in value &&
    value.acknowledgement === acknowledgement
  );
}

function isPendingMutationReceipt(value: unknown): boolean {
  return isMutationReceipt(value, 'pending');
}

function isCompletedMutationReceipt(value: unknown): boolean {
  return isMutationReceipt(value, 'complete');
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    const fields = new Map(Object.entries(value));
    return Object.fromEntries([...fields.keys()].sort().map((key) => [key, stableValue(fields.get(key))]));
  }
  return value;
}
