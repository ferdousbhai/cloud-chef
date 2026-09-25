import { WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE } from '../../app/agents/builder-workspace-api';

/**
 * The execution surface re-attachment is allowed to touch. It can observe an execution a previous
 * Durable Object instance started, and it deliberately cannot start one: adopting an outcome must
 * never be able to degrade into repeating the command that produced it.
 */
type ReattachableExecutionRuntime<THandle> = {
  getExec(id: string, options: { backend: string; encoding: 'utf8'; resume: 'tail' | 'full' }): Promise<THandle>;
};

type DisposableExecutionHandle = { [Symbol.dispose](): void };

export const WORKSPACE_RESTART_INDETERMINATE_MESSAGE =
  'The workspace restarted while this command was running and its execution could no longer be found, so the command outcome is unknown and was not repeated.';

/**
 * The execution a previous instance started is gone. Named separately from an ordinary command
 * failure because nothing was observed: the command may have completed, and re-running it is the
 * one recovery that is never safe.
 */
export class WorkspaceExecutionNotReattachableError extends Error {
  readonly code = WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE;

  constructor(cause?: unknown) {
    // Workers RPC may preserve only an exception message, so the stable code travels in both.
    super(`[${WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE}] ${WORKSPACE_RESTART_INDETERMINATE_MESSAGE}`, { cause });
    this.name = 'WorkspaceExecutionNotReattachableError';
  }
}

/**
 * Whether the interrupted execution is still observable. A container outlives the Durable Object
 * reset that a code update causes, so the answer is usually yes; anything that stops this from
 * answering counts as no, because an outcome nobody can see stays unknown.
 */
export async function isExecutionReattachable(
  runtime: ReattachableExecutionRuntime<DisposableExecutionHandle>,
  id: string,
  backend: string,
): Promise<boolean> {
  let handle: DisposableExecutionHandle;
  try {
    handle = await runtime.getExec(id, { backend, encoding: 'utf8', resume: 'tail' });
  } catch {
    return false;
  }
  try {
    handle[Symbol.dispose]();
  } catch {
    // Releasing the probe's stream is bookkeeping; the execution it found is still there.
  }
  return true;
}

/** How long a settlement probe waits for an interrupted execution's result before calling it running. */
const EXECUTION_SETTLEMENT_PROBE_MS = 500;

/**
 * What the container shows about an execution a previous instance started. Only `finished` means
 * the command can no longer change the workspace; `unobservable` covers a missing execution, an
 * unreachable container, and a result that errored, none of which prove the command stopped.
 */
export type ExecutionObservation = 'running' | 'finished' | 'unobservable';

type ObservableExecutionHandle = DisposableExecutionHandle & { result(): Promise<object> };

/**
 * Observe whether an interrupted execution has finished, without adopting its outcome. A result the
 * container reports within the probe window is finished; one still pending after it is running.
 */
export async function observeExecutionSettlement(
  runtime: ReattachableExecutionRuntime<ObservableExecutionHandle>,
  id: string,
  backend: string,
  probeMs = EXECUTION_SETTLEMENT_PROBE_MS,
): Promise<ExecutionObservation> {
  let handle: ObservableExecutionHandle;
  try {
    handle = await runtime.getExec(id, { backend, encoding: 'utf8', resume: 'tail' });
  } catch {
    return 'unobservable';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.result().then(
        (): ExecutionObservation => 'finished',
        (): ExecutionObservation => 'unobservable',
      ),
      new Promise<ExecutionObservation>((resolve) => {
        timer = setTimeout(() => resolve('running'), probeMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    try {
      handle[Symbol.dispose]();
    } catch {
      // Releasing the probe's stream is bookkeeping; the observation already stands.
    }
  }
}

/** Adopt the interrupted execution, replaying everything it has produced so far. */
export async function reattachExecution<THandle>(
  runtime: ReattachableExecutionRuntime<THandle>,
  id: string,
  backend: string,
): Promise<THandle> {
  try {
    return await runtime.getExec(id, { backend, encoding: 'utf8', resume: 'full' });
  } catch (error) {
    throw new WorkspaceExecutionNotReattachableError(error);
  }
}
