import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectWorkspaceRpc } from '~/agents/builder-workspace-api';
import { UserWorkspaceRuntimeClient } from './user-workspace-runtime-client';

describe('UserWorkspaceRuntimeClient direct ProjectWorkspace RPC', () => {
  it('returns a completed journal receipt without executing the operation again', async () => {
    const execute = vi.fn(async () => ({ shouldNotRun: true }));
    const { client, calls } = harness((operation) =>
      operation === 'beginToolOperation' ? { status: 'completed', result: { path: '/project/a.ts' } } : undefined,
    );

    await expect(client.executeToolOnce('call-1', 'write', { path: '/project/a.ts' }, execute)).resolves.toEqual({
      path: '/project/a.ts',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(calls.map((request) => request.operation)).toEqual(['initializeProjectIdentity', 'beginToolOperation']);
  });

  it('restates a busy operation lane as retryable guidance', async () => {
    const { client } = harness((operation) => {
      if (operation === 'getWorkspaceSnapshot') {
        throw new Error('[workspace_operation_conflict] validate is running; retry after 12000ms.');
      }
      return undefined;
    });

    await expect(client.refresh()).rejects.toMatchObject({
      name: 'WorkspaceBusyError',
      code: 'workspace_operation_conflict',
      retryable: true,
      activeKind: 'validate',
      retryAfterMs: 12_000,
      message: 'The project workspace is busy with validate. Retry in 12 seconds.',
    });
  });

  it('waits out a lane held by a sibling write instead of failing the batched tool call', async () => {
    // The Pi loop runs one assistant message's tool calls concurrently, but the operation lane is
    // an exclusive mutex. Without the wait, a message that writes several files lands one and
    // turns the rest into tool errors the model has to spend whole turns retrying.
    let remainingConflicts = 3;
    const { client, calls } = harness((operation) => {
      if (operation === 'getWorkspaceSnapshot') {
        if (remainingConflicts > 0) {
          remainingConflicts -= 1;
          throw new Error('[workspace_operation_conflict] write is running; retry after 900000ms.');
        }
        return {
          state: { initialized: true, revision: 1, resetRevision: 0, fileCount: 0, totalBytes: 0, seeding: false },
          files: [],
        };
      }
      return undefined;
    });

    await expect(client.refresh()).resolves.toMatchObject({ initialized: true });
    expect(remainingConflicts).toBe(0);
    expect(calls.filter((request) => request.operation === 'getWorkspaceSnapshot')).toHaveLength(4);
  });

  it('does not queue behind a lane kind that legitimately runs for minutes', async () => {
    // Waiting on `exec` or `validate` would burn the whole window and still fail, so those stay
    // immediate. The `retryAfterMs` here is the lease deadline, not a completion estimate.
    const attempts: string[] = [];
    const { client } = harness((operation) => {
      if (operation === 'getWorkspaceSnapshot') {
        attempts.push(operation);
        throw new Error('[workspace_operation_conflict] exec is running; retry after 900000ms.');
      }
      return undefined;
    });

    await expect(client.refresh()).rejects.toMatchObject({ name: 'WorkspaceBusyError', activeKind: 'exec' });
    expect(attempts).toHaveLength(1);
  });

  it('terminalizes a committed mutation whose display acknowledgement was interrupted', async () => {
    const pending = {
      kind: 'workspace-mutation-receipt',
      version: 1,
      committed: true,
      acknowledgement: 'pending',
      tool: 'write',
      files: [],
    };
    const completed = { ...pending, acknowledgement: 'complete' };
    const execute = vi.fn(async () => ({ shouldNotRun: true }));
    const { client, stub } = harness((operation) => {
      if (operation === 'beginToolOperation') {
        return { status: 'completed', result: pending };
      }
      if (operation === 'completeToolOperation') {
        return completed;
      }
      return undefined;
    });

    await expect(client.executeToolOnce('call-1', 'write', { path: '/project/a.ts' }, execute)).resolves.toEqual(
      completed,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(stub.completeToolOperation).toHaveBeenCalledWith({ toolCallId: 'call-1', result: pending });
  });

  it('surfaces a committed mutation when the native tool reports a post-commit failure', async () => {
    const result = { error: 'The workspace refresh failed after the write committed.' };
    const receipt = {
      kind: 'workspace-mutation-receipt',
      version: 1,
      committed: true,
      acknowledgement: 'complete',
      tool: 'write',
      files: [{ path: '/project/a.ts' }],
    };
    const { client } = harness((operation) => {
      if (operation === 'beginToolOperation') {
        return { status: 'execute' };
      }
      return operation === 'completeToolOperation' ? receipt : undefined;
    });

    await expect(
      client.executeToolOnce('call-1', 'write', { path: '/project/a.ts' }, async () => result),
    ).resolves.toEqual(receipt);
  });

  it('recovers a lost acknowledgement response after one write without executing it twice', async () => {
    const pending = {
      kind: 'workspace-mutation-receipt',
      version: 1,
      committed: true,
      acknowledgement: 'pending',
      tool: 'write',
      files: [{ path: '/project/a.ts' }],
    };
    const completed = { ...pending, acknowledgement: 'complete' };
    let begins = 0;
    let completions = 0;
    const result = { path: '/project/a.ts', bytesWritten: 12 };
    const execute = vi.fn(async () => result);
    const { client, stub } = harness((operation) => {
      if (operation === 'beginToolOperation') {
        begins += 1;
        return begins === 1 ? { status: 'execute' } : { status: 'completed', result: pending };
      }
      if (operation === 'completeToolOperation') {
        completions += 1;
        if (completions === 1) {
          throw Object.assign(new Error('RPC response lost after durable commit'), { retryable: true });
        }
        return completed;
      }
      return undefined;
    });

    await expect(client.executeToolOnce('call-1', 'write', { path: '/project/a.ts' }, execute)).resolves.toEqual(
      result,
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(begins).toBe(2);
    expect(completions).toBe(2);
    expect(stub.completeToolOperation).toHaveBeenLastCalledWith({ toolCallId: 'call-1', result });
  });

  it('fails closed when the durable journal reports an indeterminate operation', async () => {
    const execute = vi.fn(async () => ({ shouldNotRun: true }));
    const { client } = harness((operation) =>
      operation === 'beginToolOperation'
        ? { status: 'indeterminate', error: 'The operation may already have changed the workspace.' }
        : undefined,
    );

    await expect(client.executeToolOnce('call-1', 'exec', { command: 'npm test' }, execute)).rejects.toMatchObject({
      name: 'WorkspaceToolOperationIndeterminateError',
      code: 'workspace_tool_operation_indeterminate',
      message: expect.stringContaining('may already have changed the workspace'),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('coalesces concurrent calls with the same identifier and native RPC values', async () => {
    let resolveExecution!: (value: { exitCode: number }) => void;
    const execution = new Promise<{ exitCode: number }>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = vi.fn(() => execution);
    const { client, calls } = harness((operation, value) => {
      if (operation === 'beginToolOperation') {
        return { status: 'execute' };
      }
      if (operation === 'completeToolOperation') {
        return record(value).result;
      }
      return undefined;
    });

    const first = client.executeToolOnce('call-1', 'exec', { cwd: '/', command: 'pwd' }, execute);
    const second = client.executeToolOnce('call-1', 'exec', { command: 'pwd', cwd: '/' }, execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    resolveExecution({ exitCode: 0 });

    await expect(Promise.all([first, second])).resolves.toEqual([{ exitCode: 0 }, { exitCode: 0 }]);
    expect(calls.map((request) => request.operation)).toEqual([
      'initializeProjectIdentity',
      'beginToolOperation',
      'completeToolOperation',
    ]);
  });

  it('polls an active replay to its durable completion without executing it again', async () => {
    vi.useFakeTimers();
    try {
      let begins = 0;
      const execute = vi.fn(async () => ({ duplicated: true }));
      const { client, stub } = harness((operation) => {
        if (operation === 'beginToolOperation') {
          begins += 1;
          return begins < 3 ? { status: 'active' } : { status: 'completed', result: { ok: true } };
        }
        return undefined;
      });

      const replay = client.executeToolOnce('call-active-replay', 'write', { path: '/project/a.ts' }, execute);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(replay).resolves.toEqual({ ok: true });
      expect(stub.beginToolOperation).toHaveBeenCalledTimes(3);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels command and journal settlement when an active replay is aborted', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new DOMException('exec timed out', 'TimeoutError');
      const execute = vi.fn(async () => ({ duplicated: true }));
      const { client, stub } = harness((operation) => {
        if (operation === 'beginToolOperation') {
          return { status: 'active' };
        }
        if (operation === 'cancelExecution') {
          return undefined;
        }
        if (operation === 'cancelToolOperation') {
          return { status: 'settled' };
        }
        return undefined;
      });
      const replay = client.executeToolOnce(
        'call-aborted-active-replay',
        'exec',
        { command: 'touch changed' },
        execute,
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(reason);

      await expect(replay).rejects.toBe(reason);
      expect(stub.cancelExecution).toHaveBeenCalledWith({ operationKey: 'tool:call-aborted-active-replay' });
      expect(stub.cancelToolOperation).toHaveBeenCalledWith({
        toolCallId: 'call-aborted-active-replay',
        error: 'The active workspace tool replay was cancelled.',
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds active replay polling and stops with a typed indeterminate outcome', async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(async () => ({ duplicated: true }));
      const { client, stub } = harness((operation) =>
        operation === 'beginToolOperation' ? { status: 'active' } : undefined,
      );
      const replay = client.executeToolOnce('call-stuck-replay', 'exec', { command: 'touch changed' }, execute);
      const rejection = expect(replay).rejects.toMatchObject({
        name: 'WorkspaceToolOperationIndeterminateError',
        code: 'workspace_tool_operation_indeterminate',
        message: expect.stringContaining('active workspace tool replay observation'),
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(stub.beginToolOperation.mock.calls.length).toBeGreaterThan(1);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a mutation after cancellation wins while its journal begin is pending', async () => {
    const controller = new AbortController();
    const reason = new DOMException('tool timed out', 'TimeoutError');
    const execute = vi.fn(async () => ({ ok: true }));
    const { client, stub } = harness((operation) => {
      if (operation === 'beginToolOperation') {
        controller.abort(reason);
        return { status: 'execute' };
      }
      if (operation === 'cancelToolOperation') {
        return { status: 'settled' };
      }
      return undefined;
    });

    await expect(
      client.executeToolOnce('call-timeout', 'write', { path: '/project/a.ts' }, execute, controller.signal),
    ).rejects.toBe(reason);

    expect(execute).not.toHaveBeenCalled();
    expect(stub.cancelToolOperation).toHaveBeenCalledWith({
      toolCallId: 'call-timeout',
      error: 'The workspace tool operation was cancelled before execution started.',
    });
  });

  it('rejects concurrent identifier reuse with different arguments', async () => {
    let resolveExecution!: (value: { ok: true }) => void;
    const execution = new Promise<{ ok: true }>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = vi.fn(() => execution);
    const { client } = harness((operation, value) =>
      operation === 'beginToolOperation' ? { status: 'execute' } : record(value).result,
    );

    const first = client.executeToolOnce('call-1', 'write', { path: '/project/a.ts' }, execute);
    await expect(
      client.executeToolOnce('call-1', 'write', { path: '/project/b.ts' }, async () => ({ ok: false })),
    ).rejects.toThrow('reused with different arguments');
    resolveExecution({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
  });

  it.each(['write', 'edit'] as const)(
    'waits for a canceled %s execution to settle without allowing a late mutation',
    async (toolName) => {
      const controller = new AbortController();
      const reason = new DOMException(`${toolName} timed out`, 'TimeoutError');
      const nativeOperation = deferred<void>();
      const state = { content: 'before' };
      const { client, stub } = harness((operation) => {
        if (operation === 'beginToolOperation') {
          return { status: 'execute' };
        }
        if (operation === 'cancelToolOperation') {
          return { status: 'settled' };
        }
        return undefined;
      });

      const execution = client.executeToolOnce(
        `call-${toolName}-timeout`,
        toolName,
        { path: '/project/a.ts' },
        async () => {
          await nativeOperation.promise;
          controller.signal.throwIfAborted();
          state.content = 'after';
          return { ok: true };
        },
        controller.signal,
      );
      await vi.waitFor(() => expect(stub.beginToolOperation).toHaveBeenCalledOnce());
      controller.abort(reason);
      await vi.waitFor(() => expect(stub.cancelToolOperation).toHaveBeenCalledOnce());

      let settled = false;
      void execution.catch(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      nativeOperation.resolve();
      await expect(execution).rejects.toBe(reason);
      expect(state.content).toBe('before');
      expect(stub.beginToolOperation).toHaveBeenCalledOnce();
      expect(stub.cancelToolOperation).toHaveBeenCalledWith({
        toolCallId: `call-${toolName}-timeout`,
        error: 'The workspace tool operation was cancelled after its execution settled.',
      });

      await Promise.resolve();
      expect(state.content).toBe('before');
    },
  );

  it('does not treat an actively executing journal row as safely indeterminate', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new DOMException('write timed out', 'TimeoutError');
      const nativeOperation = deferred<void>();
      const state = { content: 'before' };
      let cancellations = 0;
      const { client, stub } = harness((operation) => {
        if (operation === 'beginToolOperation') {
          return { status: 'execute' };
        }
        if (operation === 'cancelToolOperation') {
          cancellations += 1;
          return { status: cancellations === 1 ? 'active' : 'settled' };
        }
        return undefined;
      });

      const execution = client.executeToolOnce(
        'call-active-timeout',
        'write',
        { path: '/project/a.ts' },
        async () => {
          await nativeOperation.promise;
          controller.signal.throwIfAborted();
          state.content = 'after';
          return { ok: true };
        },
        controller.signal,
      );
      await vi.waitFor(() => expect(stub.beginToolOperation).toHaveBeenCalledOnce());
      controller.abort(reason);
      nativeOperation.resolve();
      await vi.waitFor(() => expect(stub.cancelToolOperation).toHaveBeenCalledOnce());

      let settled = false;
      void execution.catch(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(execution).rejects.toBe(reason);
      expect(stub.beginToolOperation).toHaveBeenCalledOnce();
      expect(stub.cancelToolOperation).toHaveBeenCalledTimes(2);
      expect(stub.cancelToolOperation).toHaveBeenLastCalledWith({
        toolCallId: 'call-active-timeout',
        error: 'The workspace tool operation was cancelled after its execution settled.',
      });
      expect(state.content).toBe('before');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for command termination and preserves an aborted mutating exec as indeterminate', async () => {
    const controller = new AbortController();
    const reason = new DOMException('exec timed out', 'TimeoutError');
    let closeStream!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        closeStream = () => streamController.close();
      },
    });
    const cancellation = deferred<void>();
    const state = { commandActive: true, content: 'before' };
    const { client, stub } = harness((operation) => {
      if (operation === 'beginToolOperation') {
        return { status: 'execute' };
      }
      if (operation === 'executeStream') {
        return stream;
      }
      if (operation === 'cancelExecution') {
        return cancellation.promise.then(() => {
          state.commandActive = false;
          closeStream();
        });
      }
      if (operation === 'cancelToolOperation') {
        return { status: 'settled' };
      }
      return undefined;
    });

    const execution = client.executeToolOnce(
      'call-exec-timeout',
      'exec',
      { command: 'touch changed' },
      () => client.executeCommand({ command: 'touch changed', abortSignal: controller.signal }),
      controller.signal,
    );
    await vi.waitFor(() => expect(stub.executeStream).toHaveBeenCalledOnce());
    controller.abort(reason);
    await vi.waitFor(() =>
      expect(stub.cancelExecution).toHaveBeenCalledWith({ operationKey: 'tool:call-exec-timeout' }),
    );

    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    cancellation.resolve();
    await expect(execution).rejects.toBe(reason);
    expect(state).toEqual({ commandActive: false, content: 'before' });
    expect(stub.cancelToolOperation).toHaveBeenCalledWith({
      toolCallId: 'call-exec-timeout',
      error: 'The workspace tool operation was cancelled after its execution settled.',
    });
    expect(stub.completeToolOperation).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(state.content).toBe('before');
  });

  it('does not report an exec timeout while cancellation confirmation is retrying', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new DOMException('exec timed out', 'TimeoutError');
      let closeStream!: () => void;
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          closeStream = () => streamController.close();
        },
      });
      const cancellation = deferred<void>();
      let cancellationAttempts = 0;
      const { client, stub } = harness((operation) => {
        if (operation === 'beginToolOperation') {
          return { status: 'execute' };
        }
        if (operation === 'executeStream') {
          return stream;
        }
        if (operation === 'cancelExecution') {
          cancellationAttempts += 1;
          if (cancellationAttempts === 1) {
            throw Object.assign(new Error('cancellation transport reset'), { retryable: true });
          }
          return cancellation.promise.then(closeStream);
        }
        if (operation === 'cancelToolOperation') {
          return { status: 'settled' };
        }
        return undefined;
      });

      const execution = client.executeToolOnce(
        'call-exec-retry',
        'exec',
        { command: 'touch changed' },
        () => client.executeCommand({ command: 'touch changed', abortSignal: controller.signal }),
        controller.signal,
      );
      await vi.waitFor(() => expect(stub.executeStream).toHaveBeenCalledOnce());
      controller.abort(reason);
      await vi.waitFor(() => expect(stub.cancelExecution).toHaveBeenCalledTimes(1));

      let settled = false;
      void execution.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stub.cancelExecution).toHaveBeenCalledTimes(2);
      expect(settled).toBe(false);

      cancellation.resolve();
      await expect(execution).rejects.toBe(reason);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces permanent settlement failures as typed indeterminate outcomes', async () => {
    const settlementFailure = new SyntaxError('invalid cancellation request');
    const { client, stub } = harness((operation) => {
      if (operation === 'beginToolOperation') {
        return { status: 'execute' };
      }
      if (operation === 'cancelToolOperation') {
        throw settlementFailure;
      }
      return undefined;
    });

    await expect(
      client.executeToolOnce('call-permanent-settlement', 'exec', { command: 'false' }, async () => {
        throw new Error('command failed');
      }),
    ).rejects.toMatchObject({
      name: 'WorkspaceToolOperationIndeterminateError',
      code: 'workspace_tool_operation_indeterminate',
      cause: settlementFailure,
    });
    expect(stub.cancelToolOperation).toHaveBeenCalledOnce();
  });

  it('surfaces permanent command-cancellation RPC failures as typed indeterminate outcomes', async () => {
    const controller = new AbortController();
    const cancellationFailure = new SyntaxError('invalid command cancellation');
    let closeStream!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        closeStream = () => streamController.close();
      },
    });
    const { client, stub } = harness((operation) => {
      if (operation === 'beginToolOperation') {
        return { status: 'execute' };
      }
      if (operation === 'executeStream') {
        return stream;
      }
      if (operation === 'cancelExecution') {
        closeStream();
        throw cancellationFailure;
      }
      if (operation === 'cancelToolOperation') {
        return { status: 'settled' };
      }
      return undefined;
    });

    const execution = client.executeToolOnce(
      'call-permanent-command-cancellation',
      'exec',
      { command: 'touch changed' },
      () => client.executeCommand({ command: 'touch changed', abortSignal: controller.signal }),
      controller.signal,
    );
    await vi.waitFor(() => expect(stub.executeStream).toHaveBeenCalledOnce());
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      name: 'WorkspaceToolOperationIndeterminateError',
      code: 'workspace_tool_operation_indeterminate',
      cause: expect.any(AggregateError),
    });
    expect(stub.cancelExecution).toHaveBeenCalledOnce();
  });

  it('awaits every cancellation branch and aggregates their failures', async () => {
    const controller = new AbortController();
    const commandFailure = new SyntaxError('command cancellation failed');
    const journalFailure = new SyntaxError('journal cancellation failed');
    const journalSettlement = deferred<never>();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void controller;
      },
    });
    const { client, stub } = harness((operation) => {
      if (operation === 'beginToolOperation') {
        return { status: 'execute' };
      }
      if (operation === 'executeStream') {
        return stream;
      }
      if (operation === 'cancelExecution') {
        throw commandFailure;
      }
      if (operation === 'cancelToolOperation') {
        return journalSettlement.promise;
      }
      return undefined;
    });

    const execution = client.executeToolOnce(
      'call-aggregate-cancellation',
      'exec',
      { command: 'touch changed' },
      () => client.executeCommand({ command: 'touch changed', abortSignal: controller.signal }),
      controller.signal,
    );
    await vi.waitFor(() => expect(stub.executeStream).toHaveBeenCalledOnce());
    controller.abort();

    let settled = false;
    void execution.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    journalSettlement.reject(journalFailure);
    await expect(execution).rejects.toMatchObject({
      name: 'WorkspaceToolOperationIndeterminateError',
      code: 'workspace_tool_operation_indeterminate',
      cause: expect.any(AggregateError),
    });
  });

  it('bounds hung cancellation settlement and reports a typed indeterminate outcome', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = new Promise<never>(() => undefined);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          void controller;
        },
      });
      const { client, stub } = harness((operation) => {
        if (operation === 'beginToolOperation') {
          return { status: 'execute' };
        }
        if (operation === 'executeStream') {
          return stream;
        }
        if (operation === 'cancelExecution' || operation === 'cancelToolOperation') {
          return pending;
        }
        return undefined;
      });
      const execution = client.executeToolOnce(
        'call-bounded-cancellation',
        'exec',
        { command: 'touch changed' },
        () => client.executeCommand({ command: 'touch changed', abortSignal: controller.signal }),
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      const rejection = expect(execution).rejects.toMatchObject({
        name: 'WorkspaceToolOperationIndeterminateError',
        code: 'workspace_tool_operation_indeterminate',
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(stub.cancelExecution.mock.calls.length).toBeGreaterThan(1);
      expect(stub.cancelToolOperation.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for canceled dependency installation to terminate before settling', async () => {
    const controller = new AbortController();
    const reason = new DOMException('install timed out', 'TimeoutError');
    const installation = deferred<{ content: string }>();
    const cancellation = deferred<void>();
    const { client, stub } = harness((operation) => {
      if (operation === 'installDependenciesTool') {
        return installation.promise;
      }
      if (operation === 'cancelExecution') {
        return cancellation.promise;
      }
      if (operation === 'cancelToolOperation') {
        return { status: 'settled' };
      }
      if (operation === 'getWorkspaceSnapshot') {
        return {
          state: { initialized: true, revision: 1, resetRevision: 0, fileCount: 0, totalBytes: 0, seeding: false },
          files: [],
        };
      }
      return undefined;
    });

    const execution = client.installDependencies({
      toolCallId: 'call-install-timeout',
      input: {},
      mode: 'add',
      packages: ['example'],
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(stub.installDependenciesTool).toHaveBeenCalledOnce());
    controller.abort(reason);
    await vi.waitFor(() =>
      expect(stub.cancelExecution).toHaveBeenCalledWith({ operationKey: 'tool:call-install-timeout' }),
    );
    expect(stub.cancelToolOperation).toHaveBeenCalledWith({
      toolCallId: 'call-install-timeout',
      error: 'The workspace tool operation was cancelled after its execution settled.',
    });
    installation.resolve({ content: 'installed' });

    let settled = false;
    void execution.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    cancellation.resolve();
    await expect(execution).rejects.toBe(reason);
    expect(stub.cancelToolOperation).toHaveBeenCalledWith({
      toolCallId: 'call-install-timeout',
      error: 'The workspace tool operation was cancelled after its execution settled.',
    });
  });

  it('cancels the exact active validation and forgets it after the RPC settles', async () => {
    let finishValidation!: (value: { content: string }) => void;
    const validationResult = new Promise<{ content: string }>((resolve) => {
      finishValidation = resolve;
    });
    const { client, stub } = harness((operation) => {
      if (operation === 'validateTool') {
        return validationResult;
      }
      return undefined;
    });

    const validation = client.validate({ toolCallId: 'validation-1', input: {} });
    await vi.waitFor(() => expect(stub.validateTool).toHaveBeenCalledOnce());

    await client.cancelActiveValidation();
    expect(stub.cancelValidation).toHaveBeenCalledWith({ toolCallId: 'validation-1' });

    finishValidation({ content: 'cancelled' });
    await expect(validation).resolves.toEqual({ content: 'cancelled' });
    await client.cancelActiveValidation();
    expect(stub.cancelValidation).toHaveBeenLastCalledWith({});
  });

  it('cancels a remotely active validation after volatile client state is lost', async () => {
    const { client, stub } = harness(() => undefined);

    await client.cancelActiveValidation();

    expect(stub.cancelValidation).toHaveBeenCalledWith({});
  });

  it('cancels the exact validation when the AI SDK abort signal fires', async () => {
    let finishValidation!: (value: { content: string }) => void;
    const validationResult = new Promise<{ content: string }>((resolve) => {
      finishValidation = resolve;
    });
    const { client, stub } = harness((operation) => {
      if (operation === 'validateTool') {
        return validationResult;
      }
      if (operation === 'cancelValidation') {
        finishValidation({ content: 'cancelled' });
      }
      return undefined;
    });
    const controller = new AbortController();

    const validation = client.validate({ toolCallId: 'validation-1', input: {}, abortSignal: controller.signal });
    await vi.waitFor(() => expect(stub.validateTool).toHaveBeenCalledOnce());
    controller.abort();

    await expect(validation).rejects.toMatchObject({ name: 'AbortError' });
    expect(stub.cancelValidation).toHaveBeenCalledWith({ toolCallId: 'validation-1' });
  });

  it('forgets an aborted validation even when its cancellation RPC fails', async () => {
    let rejectValidation!: (error: Error) => void;
    const firstValidation = new Promise<never>((_resolve, reject) => {
      rejectValidation = reject;
    });
    const cancellationFailure = new Error('cancellation RPC failed');
    const { client, stub } = harness((operation, value) => {
      if (operation === 'validateTool') {
        return record(value).toolCallId === 'validation-1' ? firstValidation : { content: 'validated' };
      }
      if (operation === 'cancelValidation') {
        rejectValidation(new Error('validation cancelled'));
        throw cancellationFailure;
      }
      return undefined;
    });
    const controller = new AbortController();

    const aborted = client.validate({ toolCallId: 'validation-1', input: {}, abortSignal: controller.signal });
    await vi.waitFor(() => expect(stub.validateTool).toHaveBeenCalledOnce());
    controller.abort();

    await expect(aborted).rejects.toMatchObject({
      name: 'WorkspaceToolOperationIndeterminateError',
      code: 'workspace_tool_operation_indeterminate',
      cause: cancellationFailure,
    });
    await expect(client.validate({ toolCallId: 'validation-2', input: {} })).resolves.toEqual({ content: 'validated' });
  });

  it('propagates typed stub failures and preserves the original tool error', async () => {
    const failure = new Error('command failed');
    const { client, stub } = harness((operation) => {
      if (operation === 'beginToolOperation') {
        return { status: 'execute' };
      }
      return operation === 'cancelToolOperation' ? { status: 'settled' } : undefined;
    });

    await expect(
      client.executeToolOnce('call-1', 'exec', { command: 'false' }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(stub.cancelToolOperation).toHaveBeenCalledWith({ toolCallId: 'call-1', error: 'command failed' });
  });

  it('does not mark a command failed when RPC preserved only the pending-sync message marker', async () => {
    const rpcError = new Error('[workspace_sync_pending] Computer synchronization is pending.');
    rpcError.name = 'Error';
    const { client, stub } = harness((operation) =>
      operation === 'beginToolOperation' ? { status: 'execute' } : undefined,
    );

    await expect(
      client.executeToolOnce('call-1', 'exec', { command: 'touch file' }, async () => {
        throw rpcError;
      }),
    ).rejects.toBe(rpcError);

    expect(stub.failToolOperation).not.toHaveBeenCalled();
  });

  it('rejects the normal error object returned by the official Computer exec wrapper without closing the journal', async () => {
    const { client, stub } = harness((operation) =>
      operation === 'beginToolOperation' ? { status: 'execute' } : undefined,
    );

    await expect(
      client.executeToolOnce('call-1', 'exec', { command: 'touch file' }, async () => ({
        command: 'touch file',
        backend: 'container-shell',
        error: '[workspace_sync_pending] Computer synchronization is pending.',
      })),
    ).rejects.toMatchObject({ code: 'workspace_sync_pending' });

    expect(stub.completeToolOperation).not.toHaveBeenCalled();
    expect(stub.failToolOperation).not.toHaveBeenCalled();
  });

  it('races stub resolution and identity initialization as part of an abortable read', async () => {
    const controller = new AbortController();
    const reason = new DOMException('read timed out', 'TimeoutError');
    const identity = deferred<void>();
    const { client, stub } = harness((operation) =>
      operation === 'initializeProjectIdentity' ? identity.promise : undefined,
    );

    const result = client.readText('/home/project/a.ts', controller.signal);
    await vi.waitFor(() => expect(stub.initializeProjectIdentity).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(stub.readText).not.toHaveBeenCalled();
    identity.resolve();
  });

  it('aborts a pending readText RPC without waiting for the read-only remote work', async () => {
    const controller = new AbortController();
    const reason = new DOMException('read timed out', 'TimeoutError');
    const read = deferred<{
      path: string;
      content: string;
      encoding: 'utf8';
      size: number;
      sha256: string;
      revision: number;
    }>();
    const { client, stub } = harness((operation) => (operation === 'readText' ? read.promise : undefined));

    const result = client.readText('/home/project/a.ts', controller.signal);
    await vi.waitFor(() => expect(stub.readText).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    read.resolve({
      path: '/home/project/a.ts',
      content: 'late',
      encoding: 'utf8',
      size: 4,
      sha256: 'a'.repeat(64),
      revision: 1,
    });
  });

  it('drops a disconnected command stub and surfaces a retryable terminal error', async () => {
    const encoder = new TextEncoder();
    const disconnectedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('ReadableStream received over RPC disconnected prematurely.'));
      },
    });
    const completedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: 'result',
              streamTruncated: false,
              result: { exitCode: 0, stdout: 'complete\n', stderr: '' },
            })}\n`,
          ),
        );
        controller.close();
      },
    });
    const staleStub = workspaceStub({
      executeStream: vi.fn().mockResolvedValue(disconnectedStream),
    });
    const currentStub = workspaceStub({
      executeStream: vi.fn().mockResolvedValue(completedStream),
    });
    const namespace = {
      idFromName: vi.fn(() => ({ id: 'project-do-id' })),
      get: vi.fn().mockReturnValueOnce(staleStub).mockReturnValue(currentStub),
    };
    const client = new UserWorkspaceRuntimeClient(
      {
        CLOUDCHEF_USER_RUNTIME: '1',
        CLOUDCHEF_USER_ID: 'user-1',
        PROJECT_WORKSPACE: namespace,
      } as unknown as Env,
      'project-1',
      () => 'user-1',
    );

    await expect(client.executeCommand({ command: 'pnpm test' })).rejects.toThrow(
      'The workspace command connection dropped before completion. The connection was reset; retry the command.',
    );
    await expect(client.executeCommand({ command: 'pnpm test' })).resolves.toEqual({
      exitCode: 0,
      stdout: 'complete\n',
      stderr: '',
    });

    expect(namespace.get).toHaveBeenCalledTimes(2);
    expect(staleStub.initializeProjectIdentity).toHaveBeenCalledOnce();
    expect(currentStub.initializeProjectIdentity).toHaveBeenCalledOnce();
  });

  it('updates its cached revision when a Computer write commits', async () => {
    const state = (revision: number) => ({
      initialized: true,
      revision,
      resetRevision: 0,
      fileCount: 1,
      totalBytes: 3,
      seeding: false,
    });
    let revision = 1;
    const { client, stub } = harness((operation) => {
      if (operation === 'getWorkspaceSnapshot') {
        return { state: state(revision), files: [] };
      }
      if (operation === 'applyChanges') {
        revision = 2;
        return { ok: true, state: state(revision), changedPaths: ['/home/project/a.ts'] };
      }
      return undefined;
    });

    await client.refresh();
    await client.computer.fs.writeFile('/home/project/a.ts', new TextEncoder().encode('new'));

    expect(client.getState().revision).toBe(2);
    expect(stub.applyChanges).toHaveBeenCalledOnce();
  });

  it('uses RPC-native bytes and streams and performs no internal HTTP fetch', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const stream = new Blob([bytes]).stream();
    const { client, stub, namespace } = harness((operation) => {
      if (operation === 'readWorkspaceFile') {
        return {
          path: '/home/project/blob.bin',
          bytes,
          encoding: 'base64',
          size: bytes.byteLength,
          mode: 0o100644,
          sha256: 'a'.repeat(64),
          revision: 1,
        };
      }
      if (operation === 'streamWorkspaceFile') {
        return stream;
      }
      return undefined;
    });

    await expect(client.readFile('/home/project/blob.bin')).resolves.toMatchObject({ bytes });
    await expect(client.computer.fs.readFile('/home/project/blob.bin')).resolves.toBe(stream);
    expect(namespace.idFromName).toHaveBeenCalledWith('project-1');
    expect(stub.initializeProjectIdentity).toHaveBeenCalledWith({ projectId: 'project-1', userId: 'user-1' });

    const source = readFileSync(new URL('./user-workspace-runtime-client.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('authorization');
    expect(source).not.toContain('base64');
    expect(source).not.toContain('/v1/projects/');
  });

  it('rejects a user mismatch before resolving a project stub', async () => {
    const { namespace } = harness(() => undefined, 'different-user');
    const client = new UserWorkspaceRuntimeClient(
      {
        CLOUDCHEF_USER_RUNTIME: '1',
        CLOUDCHEF_USER_ID: 'user-1',
        PROJECT_WORKSPACE: namespace,
      } as unknown as Env,
      'project-1',
      () => 'different-user',
    );

    await expect(client.readText('/home/project/a.ts')).rejects.toThrow('not configured for this project owner');
    expect(namespace.get).not.toHaveBeenCalled();
  });

  it.each(['Durable Object reset because its code was updated.', 'Container service disconnected.'])(
    'drops a cached ProjectWorkspace stub after a transport reset: %s',
    async (message) => {
      const reset = new Error(message);
      const staleStub = workspaceStub({
        getWorkspaceSnapshot: vi.fn().mockRejectedValue(reset),
      });
      const currentState = {
        initialized: true,
        revision: 1,
        resetRevision: 0,
        fileCount: 0,
        totalBytes: 0,
        seeding: false,
      };
      const currentStub = workspaceStub({
        getWorkspaceSnapshot: vi.fn().mockResolvedValue({ state: currentState, files: [] }),
      });
      const namespace = {
        idFromName: vi.fn(() => ({ id: 'project-do-id' })),
        get: vi.fn().mockReturnValueOnce(staleStub).mockReturnValue(currentStub),
      };
      const client = new UserWorkspaceRuntimeClient(
        {
          CLOUDCHEF_USER_RUNTIME: '1',
          CLOUDCHEF_USER_ID: 'user-1',
          PROJECT_WORKSPACE: namespace,
        } as unknown as Env,
        'project-1',
        () => 'user-1',
      );

      await expect(client.refresh()).rejects.toBe(reset);
      await expect(client.refresh()).resolves.toEqual(currentState);

      expect(namespace.get).toHaveBeenCalledTimes(2);
      expect(staleStub.initializeProjectIdentity).toHaveBeenCalledOnce();
      expect(currentStub.initializeProjectIdentity).toHaveBeenCalledOnce();
    },
  );
});

type RpcCall = { operation: string; value: unknown };

function harness(respond: (operation: string, value: unknown) => unknown, userId = 'user-1') {
  const calls: RpcCall[] = [];
  const method = (operation: string) =>
    vi.fn(async (value?: unknown, second?: unknown) => {
      const payload = second === undefined ? value : [value, second];
      calls.push({ operation, value: payload });
      return respond(operation, payload);
    });
  const stub = {
    initializeProjectIdentity: method('initializeProjectIdentity'),
    beginToolOperation: method('beginToolOperation'),
    completeToolOperation: method('completeToolOperation'),
    failToolOperation: method('failToolOperation'),
    cancelToolOperation: method('cancelToolOperation'),
    installDependenciesTool: method('installDependenciesTool'),
    validateTool: method('validateTool'),
    cancelValidation: method('cancelValidation'),
    readText: method('readText'),
    readWorkspaceFile: method('readWorkspaceFile'),
    streamWorkspaceFile: method('streamWorkspaceFile'),
    executeStream: method('executeStream'),
    cancelExecution: method('cancelExecution'),
    getWorkspaceSnapshot: method('getWorkspaceSnapshot'),
    applyChanges: method('applyChanges'),
  };
  const namespace = {
    idFromName: vi.fn(() => ({ id: 'project-do-id' })),
    get: vi.fn(() => stub),
  };
  const env = {
    CLOUDCHEF_USER_RUNTIME: '1',
    CLOUDCHEF_USER_ID: userId,
    PROJECT_WORKSPACE: namespace,
  } as unknown as Env;
  return {
    client: new UserWorkspaceRuntimeClient(env, 'project-1', () => userId),
    calls,
    stub,
    namespace,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function workspaceStub(overrides: Record<string, unknown> = {}) {
  return {
    initializeProjectIdentity: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ProjectWorkspaceRpc;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}
