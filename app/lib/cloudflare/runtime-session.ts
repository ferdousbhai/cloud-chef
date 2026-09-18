import { atom } from 'nanostores';
import { z } from 'zod';
import { aiGatewayCreditStatusSchema, type AiGatewayCreditStatus } from './ai-gateway-credit';

type UserRuntimeSession = {
  endpoint: string;
  token: string;
  expiresAt: number;
  aiGatewayCreditStatus?: AiGatewayCreditStatus;
  correlationId?: string;
};

/** `workspace_preparing` is not a failure: the workspace is being built and has not answered yet. */
const userRuntimeErrorCodeSchema = z.enum([
  'cloudflare_reauthorization_required',
  'workspace_eligibility_unknown',
  'workspace_plan_required',
  'workspace_preparation_failed',
  'workspace_preparing',
]);

export type UserRuntimeErrorCode = z.infer<typeof userRuntimeErrorCodeSchema>;

/** Every member falls back on its own so one malformed field cannot discard a usable session. */
const runtimeSessionPayloadSchema = z.looseObject({
  endpoint: z.string().optional().catch(undefined),
  token: z.string().optional().catch(undefined),
  expiresAt: z.number().int().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  upgradeUrl: z.string().optional().catch(undefined),
  aiGatewayCreditStatus: aiGatewayCreditStatusSchema.optional().catch(undefined),
  correlationId: z.string().optional().catch(undefined),
});

export class UserRuntimeSessionError extends Error {
  constructor(
    message: string,
    readonly code: UserRuntimeErrorCode | null,
    /** The upgrade destination Cloudflare named, when it named one. */
    readonly upgradeUrl: string | null = null,
  ) {
    super(message);
    this.name = 'UserRuntimeSessionError';
  }
}

const REFRESH_SKEW_MS = 30_000;
const PREPARATION_RETRY_DELAY_MS = 5_000;
let pending: Promise<UserRuntimeSession> | null = null;
export const userRuntimeEndpointStore = atom<string | null>(null);
export const aiGatewayCreditStatusStore = atom<AiGatewayCreditStatus>('unknown');

/**
 * Whether the control plane last answered that the workspace is still being prepared.
 * Provisioning a stale or missing runtime takes minutes, so everything that waits on the
 * runtime can say so instead of reporting the wait as a fault.
 */
export const userWorkspacePreparingStore = atom<boolean>(false);

/**
 * The server-minted identifier for the request that admitted this browser. It lives
 * beside the session that carries it rather than in `telemetry.client`, because
 * telemetry reads this module and the reverse edge would close an import cycle.
 */
export const telemetryCorrelationIdStore = atom<string | null>(null);
let current: UserRuntimeSession | null = null;
let generation = 0;

export async function getUserRuntimeSession(
  options: { signal?: AbortSignal; retryProvisioning?: boolean } = {},
): Promise<UserRuntimeSession> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (current && current.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return current;
  }
  if (pending) {
    return waitForRuntimeSession(pending, signal);
  }
  const requestGeneration = generation;
  const request = requestUserRuntimeSession(() => generation === requestGeneration, options.retryProvisioning === true)
    .then((session) => {
      if (generation !== requestGeneration) {
        throw new Error('The runtime session request was canceled.');
      }
      current = session;
      aiGatewayCreditStatusStore.set(session.aiGatewayCreditStatus ?? 'unknown');
      userRuntimeEndpointStore.set(session.endpoint);
      telemetryCorrelationIdStore.set(session.correlationId ?? null);
      return session;
    })
    .finally(() => {
      if (pending === request) {
        pending = null;
      }
    });
  pending = request;
  return waitForRuntimeSession(request, signal);
}

/**
 * Ask the control plane again from scratch, polling on `workspace_preparing` exactly as the first
 * admission does. A release that re-provisions the workspace runtime answers 409 for as long as
 * the new image builds, and the cached session a long-open tab is still holding says nothing about
 * that. Unlike `resetUserRuntimeSession`, the published endpoint survives, so an open chat keeps
 * its mounted workspace and simply reconnects when the runtime answers again.
 */
export function refreshUserRuntimeSession(options: { signal?: AbortSignal } = {}): Promise<UserRuntimeSession> {
  if (!pending) {
    current = null;
  }
  return getUserRuntimeSession(options);
}

function waitForRuntimeSession(
  request: Promise<UserRuntimeSession>,
  signal: AbortSignal | undefined,
): Promise<UserRuntimeSession> {
  if (!signal) {
    return request;
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('The runtime session wait was canceled.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    request.then(
      (session) => {
        cleanup();
        resolve(session);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function requestUserRuntimeSession(
  isCurrent: () => boolean,
  retryProvisioning: boolean,
): Promise<UserRuntimeSession> {
  for (;;) {
    if (!isCurrent()) {
      throw new Error('The runtime session request was canceled.');
    }
    const headers = new Headers({ Accept: 'application/json' });
    if (retryProvisioning) {
      headers.set('CloudChef-Runtime-Provisioning-Retry', '1');
    }
    retryProvisioning = false;
    const response = await fetch('/api/cloudflare/runtime-session', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
    });
    const parsed = runtimeSessionPayloadSchema.safeParse(await response.json().catch(() => null));
    const payload = parsed.success ? parsed.data : null;
    if (response.status === 409 && payload?.code === 'workspace_preparing') {
      if (!isCurrent()) {
        throw new Error('The runtime session request was canceled.');
      }
      userWorkspacePreparingStore.set(true);
      await new Promise((resolve) => setTimeout(resolve, PREPARATION_RETRY_DELAY_MS));
      continue;
    }
    // Every remaining answer is final for this attempt, whether it carries a session or a
    // refusal, so the browser is no longer waiting on preparation.
    userWorkspacePreparingStore.set(false);
    if (
      !response.ok ||
      !payload?.endpoint ||
      !payload.token ||
      payload.expiresAt === undefined ||
      new URL(payload.endpoint).protocol !== 'https:'
    ) {
      const code = userRuntimeErrorCodeSchema.safeParse(payload?.code);
      throw new UserRuntimeSessionError(
        payload?.error ?? 'The user-owned CloudChef runtime is unavailable.',
        code.success ? code.data : null,
        cloudflareDashboardUrl(payload?.upgradeUrl),
      );
    }
    const session: UserRuntimeSession = {
      endpoint: new URL(payload.endpoint).origin,
      token: payload.token,
      expiresAt: payload.expiresAt,
      aiGatewayCreditStatus: payload.aiGatewayCreditStatus ?? 'unknown',
      correlationId: payload.correlationId,
    };
    return session;
  }
}

/** The link originates with Cloudflare, so only Cloudflare's dashboard may come back out of it. */
function cloudflareDashboardUrl(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  try {
    return new URL(value).origin === 'https://dash.cloudflare.com' ? value : null;
  } catch {
    return null;
  }
}

export function requireUserRuntimeEndpoint(): string {
  const endpoint = userRuntimeEndpointStore.get();
  if (!endpoint) {
    throw new Error('The user-owned CloudChef runtime has not been loaded.');
  }
  return endpoint;
}

export async function fetchUserRuntime(path: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? undefined;
  const session = await getUserRuntimeSession({ signal });
  signal?.throwIfAborted();
  return fetchWithRuntimeSession(session, path, init);
}

/**
 * The request half of `fetchUserRuntime`, for callers that must bound the request itself
 * without also bounding the wait for a workspace that is still being prepared.
 */
export function fetchWithRuntimeSession(
  session: UserRuntimeSession,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.token}`);
  return fetch(`${session.endpoint}${path.startsWith('/') ? path : `/${path}`}`, { ...init, headers });
}

export function resetUserRuntimeSession(): void {
  generation += 1;
  current = null;
  pending = null;
  userRuntimeEndpointStore.set(null);
  aiGatewayCreditStatusStore.set('unknown');
  telemetryCorrelationIdStore.set(null);
  userWorkspacePreparingStore.set(false);
}
