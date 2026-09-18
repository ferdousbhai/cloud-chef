import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aiGatewayCreditStatusStore,
  fetchUserRuntime,
  getUserRuntimeSession,
  resetUserRuntimeSession,
  UserRuntimeSessionError,
  userRuntimeEndpointStore,
  userWorkspacePreparingStore,
} from './runtime-session';

afterEach(() => {
  resetUserRuntimeSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('user runtime session', () => {
  it('prepares the runtime through the single session endpoint', async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        endpoint: 'https://workspace.example/path',
        token: 'capability-token',
        expiresAt: Date.now() + 60_000,
        aiGatewayCreditStatus: 'available',
      }),
    );
    vi.stubGlobal('fetch', request);

    await expect(getUserRuntimeSession()).resolves.toMatchObject({
      endpoint: 'https://workspace.example',
      token: 'capability-token',
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      '/api/cloudflare/runtime-session',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.any(Headers),
      }),
    );
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('Accept')).toBe('application/json');
    expect(userRuntimeEndpointStore.get()).toBe('https://workspace.example');
    expect(aiGatewayCreditStatusStore.get()).toBe('available');
  });

  it('uses an unknown credit status when an older server response omits it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          endpoint: 'https://workspace.example',
          token: 'capability-token',
          expiresAt: Date.now() + 60_000,
        }),
      ),
    );

    await getUserRuntimeSession();

    expect(aiGatewayCreditStatusStore.get()).toBe('unknown');
  });

  it('surfaces automatic provisioning failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'Unable to deploy the workspace.' }, { status: 502 })),
    );

    await expect(getUserRuntimeSession()).rejects.toThrow('Unable to deploy the workspace.');
    expect(userRuntimeEndpointStore.get()).toBeNull();
  });

  it('preserves a stable recovery code without exposing provider details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: 'workspace_plan_required',
            error: 'Enable Workers Paid in Cloudflare, then return and try again.',
          },
          { status: 502 },
        ),
      ),
    );

    await expect(getUserRuntimeSession()).rejects.toEqual(
      new UserRuntimeSessionError(
        'Enable Workers Paid in Cloudflare, then return and try again.',
        'workspace_plan_required',
      ),
    );
  });

  it('marks only an explicit user retry as permission to replace a failed provisioning attempt', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { code: 'workspace_preparation_failed', error: 'Unable to prepare the workspace.' },
          { status: 502 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { code: 'workspace_preparation_failed', error: 'Unable to prepare the workspace.' },
          { status: 502 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          endpoint: 'https://workspace.example',
          token: 'capability-token',
          expiresAt: Date.now() + 60_000,
        }),
      );
    vi.stubGlobal('fetch', request);

    await expect(getUserRuntimeSession()).rejects.toThrow('Unable to prepare the workspace.');
    await expect(getUserRuntimeSession()).rejects.toThrow('Unable to prepare the workspace.');
    await expect(getUserRuntimeSession({ retryProvisioning: true })).resolves.toMatchObject({
      endpoint: 'https://workspace.example',
    });

    const initialHeaders = new Headers(request.mock.calls[0]?.[1]?.headers);
    const repeatedHeaders = new Headers(request.mock.calls[1]?.[1]?.headers);
    const retryHeaders = new Headers(request.mock.calls[2]?.[1]?.headers);
    expect(initialHeaders.get('Accept')).toBe('application/json');
    expect(initialHeaders.has('CloudChef-Runtime-Provisioning-Retry')).toBe(false);
    expect(repeatedHeaders.has('CloudChef-Runtime-Provisioning-Retry')).toBe(false);
    expect(retryHeaders.get('Accept')).toBe('application/json');
    expect(retryHeaders.get('CloudChef-Runtime-Provisioning-Retry')).toBe('1');
  });

  it('carries the upgrade destination Cloudflare named alongside the plan code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: 'workspace_plan_required',
            error: 'Enable Workers Paid in Cloudflare, then return and try again.',
            upgradeUrl: 'https://dash.cloudflare.com/?to=/:account/workers/plans',
          },
          { status: 502 },
        ),
      ),
    );

    await expect(getUserRuntimeSession()).rejects.toEqual(
      new UserRuntimeSessionError(
        'Enable Workers Paid in Cloudflare, then return and try again.',
        'workspace_plan_required',
        'https://dash.cloudflare.com/?to=/:account/workers/plans',
      ),
    );
  });

  it('refuses an upgrade destination that is not the Cloudflare dashboard', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: 'workspace_plan_required',
            error: 'Enable Workers Paid in Cloudflare, then return and try again.',
            upgradeUrl: 'https://plans.example.invalid/upgrade',
          },
          { status: 502 },
        ),
      ),
    );

    await expect(getUserRuntimeSession()).rejects.toEqual(
      new UserRuntimeSessionError(
        'Enable Workers Paid in Cloudflare, then return and try again.',
        'workspace_plan_required',
        null,
      ),
    );
  });

  it('keeps an undeterminable plan check distinct from a plan refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: 'workspace_eligibility_unknown',
            error: 'CloudChef could not reach Cloudflare to confirm that this account can run Containers.',
          },
          { status: 503 },
        ),
      ),
    );

    await expect(getUserRuntimeSession()).rejects.toEqual(
      new UserRuntimeSessionError(
        'CloudChef could not reach Cloudflare to confirm that this account can run Containers.',
        'workspace_eligibility_unknown',
      ),
    );
  });

  it('preserves the Cloudflare reauthorization recovery code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: 'cloudflare_reauthorization_required',
            error: 'Reauthorize Cloudflare, then try again.',
          },
          { status: 409 },
        ),
      ),
    );

    await expect(getUserRuntimeSession()).rejects.toEqual(
      new UserRuntimeSessionError('Reauthorize Cloudflare, then try again.', 'cloudflare_reauthorization_required'),
    );
  });

  it('polls while durable provisioning remains active', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { code: 'workspace_preparing', error: 'CloudChef is still preparing your workspace.' },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          endpoint: 'https://workspace.example',
          token: 'capability-token',
          expiresAt: Date.now() + 60_000,
        }),
      );
    vi.stubGlobal('fetch', request);

    const session = getUserRuntimeSession();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(session).resolves.toMatchObject({ endpoint: 'https://workspace.example' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(userWorkspacePreparingStore.get()).toBe(false);
  });

  it('lets a caller cancel its wait without cancelling shared provisioning', async () => {
    let finishProvisioning: ((response: Response) => void) | undefined;
    const request = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        finishProvisioning = resolve;
      }),
    );
    vi.stubGlobal('fetch', request);
    const caller = new AbortController();

    const canceledWait = fetchUserRuntime('/v1/data', { signal: caller.signal });
    const sharedWait = getUserRuntimeSession();
    const canceled = expect(canceledWait).rejects.toMatchObject({ name: 'AbortError', message: 'Query cancelled' });
    caller.abort(new DOMException('Query cancelled', 'AbortError'));

    await canceled;
    expect(request).toHaveBeenCalledOnce();

    finishProvisioning?.(
      Response.json({
        endpoint: 'https://workspace.example',
        token: 'capability-token',
        expiresAt: Date.now() + 60_000,
      }),
    );
    await expect(sharedWait).resolves.toMatchObject({ endpoint: 'https://workspace.example' });
    expect(userRuntimeEndpointStore.get()).toBe('https://workspace.example');
    expect(request).toHaveBeenCalledOnce();
  });

  it('stops provisioning polling when the account session resets', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { code: 'workspace_preparing', error: 'The project workspace is already being prepared.' },
          { status: 409 },
        ),
      );
    vi.stubGlobal('fetch', request);

    const session = getUserRuntimeSession();
    const rejected = expect(session).rejects.toThrow('canceled');
    await vi.advanceTimersByTimeAsync(0);
    resetUserRuntimeSession();
    await vi.advanceTimersByTimeAsync(5_000);

    await rejected;
    expect(request).toHaveBeenCalledOnce();
  });
});
