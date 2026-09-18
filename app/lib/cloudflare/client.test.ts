import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeDataOperation, isWorkspacePreparingError } from './client';
import { api } from './data-api';
import { getUserRuntimeSession, UserRuntimeSessionError, userWorkspacePreparingStore } from './runtime-session';

const runtimeSession = { endpoint: 'https://runtime.test', token: 'capability', expiresAt: Number.MAX_SAFE_INTEGER };

vi.mock('./runtime-session', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    getUserRuntimeSession: vi.fn(async () => runtimeSession),
    fetchWithRuntimeSession: (_session: unknown, path: string, init?: RequestInit) => fetch(path, init),
  };
});

describe('executeDataOperation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    userWorkspacePreparingStore.set(false);
    vi.mocked(getUserRuntimeSession).mockImplementation(async () => runtimeSession);
  });

  it('aborts a data request instead of waiting forever', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const request = executeDataOperation(api.messages.initializeChat, {
      id: 'chat-1',
      sessionId: 'session-1',
    });
    const rejection = expect(request).rejects.toThrow('CloudChef timed out while running messages.initializeChat');

    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
  });

  it('waits for a workspace that is still being prepared instead of timing the operation out', async () => {
    vi.useFakeTimers();
    // Provisioning a stale or missing runtime takes minutes, and the readiness wait owns that
    // clock: the operation bound must not start until the workspace can answer.
    vi.mocked(getUserRuntimeSession).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(runtimeSession), 4 * 60_000)),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ result: { created: true } }));

    const request = executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' });
    await vi.advanceTimersByTimeAsync(4 * 60_000);

    await expect(request).resolves.toEqual({ created: true });
  });

  it('reports a stalled request as preparing rather than as a timeout while the workspace prepares', async () => {
    vi.useFakeTimers();
    userWorkspacePreparingStore.set(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const request = executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' });
    const rejection = expect(request).rejects.toMatchObject({
      name: 'WorkspacePreparingError',
      message: 'CloudChef is still preparing your workspace, so messages.initializeChat could not run yet.',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    await expect(request.catch((error: unknown) => isWorkspacePreparingError(error))).resolves.toBe(true);
  });

  it('separates a workspace that is not ready yet from a runtime that cannot be reached', async () => {
    // The same stalled request, with nothing saying the workspace is preparing, is unreachable.
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const request = executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' });
    const rejection = expect(request).rejects.toMatchObject({
      name: 'DataOperationError',
      message: 'CloudChef timed out while running messages.initializeChat. Please try again.',
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    await expect(request.catch((error: unknown) => isWorkspacePreparingError(error))).resolves.toBe(false);
  });

  it('classifies a preparation that outran the readiness deadline as preparing, not as a fault', () => {
    expect(
      isWorkspacePreparingError(
        new UserRuntimeSessionError('CloudChef is still preparing your workspace.', 'workspace_preparing'),
      ),
    ).toBe(true);
    expect(
      isWorkspacePreparingError(
        new UserRuntimeSessionError('Cloudflare could not create your workspace.', 'workspace_preparation_failed'),
      ),
    ).toBe(false);
    expect(isWorkspacePreparingError(new Error('The workspace runtime is unavailable.'))).toBe(false);
  });

  it('propagates caller cancellation to the active fetch', async () => {
    const caller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });

    const request = executeDataOperation(
      api.messages.initializeChat,
      { id: 'chat-1', sessionId: 'session-1' },
      { signal: caller.signal },
    );
    // The operation now acquires the runtime session first, so wait for the request it dispatches.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    caller.abort(new DOMException('Query cancelled', 'AbortError'));

    await expect(request).rejects.toMatchObject({ name: 'AbortError', message: 'Query cancelled' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('rejects a successful response without a result field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ unexpected: true }));

    await expect(
      executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' }),
    ).rejects.toThrow('Data operation returned a malformed response: messages.initializeChat');
  });

  it('preserves HTTP status and retryability for query policy decisions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ error: 'Invalid request' }, { status: 400 }));

    await expect(
      executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' }),
    ).rejects.toMatchObject({ name: 'DataOperationError', status: 400, retryable: false });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ error: 'Try later' }, { status: 503 }));
    await expect(
      executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' }),
    ).rejects.toMatchObject({ name: 'DataOperationError', status: 503, retryable: true });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ error: 'Overloaded', retryable: false }, { status: 503 }),
    );
    await expect(
      executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' }),
    ).rejects.toMatchObject({ name: 'DataOperationError', status: 503, retryable: false });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ error: 'Malformed marker', retryable: 'false' }, { status: 500 }),
    );
    await expect(
      executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' }),
    ).rejects.toMatchObject({ name: 'DataOperationError', status: 500, retryable: true });
  });
});
