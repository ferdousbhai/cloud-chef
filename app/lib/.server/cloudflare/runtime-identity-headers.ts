/**
 * Who a workspace runtime says it is, sent as headers on every call to the control plane's runtime
 * routes, beside the bearer secret that proves it. Headers, so the control plane can check the secret
 * before reading a body that may be megabytes long.
 */
export const RUNTIME_USER_HEADER = 'X-CloudChef-User-Id';
const RUNTIME_CONNECTION_HEADER = 'X-CloudChef-Connection-Id';
export const RUNTIME_GENERATION_HEADER = 'X-CloudChef-Connection-Generation';

export type RuntimeIdentity = { userId: string; connectionId: string; connectionGeneration: number };

export function runtimeIdentityHeaders(identity: RuntimeIdentity) {
  return {
    [RUNTIME_USER_HEADER]: identity.userId,
    [RUNTIME_CONNECTION_HEADER]: identity.connectionId,
    [RUNTIME_GENERATION_HEADER]: String(identity.connectionGeneration),
  };
}

/**
 * The identity a request's headers name: null when it names none (a runtime from before the headers),
 * 'invalid' when they are partial or malformed.
 */
export function readRuntimeIdentityHeaders(headers: Headers): RuntimeIdentity | null | 'invalid' {
  const userId = headers.get(RUNTIME_USER_HEADER);
  const connectionId = headers.get(RUNTIME_CONNECTION_HEADER);
  const generation = headers.get(RUNTIME_GENERATION_HEADER);
  if (userId === null && connectionId === null && generation === null) {
    return null;
  }
  if (
    !userId ||
    !connectionId ||
    !generation ||
    userId.length > 512 ||
    connectionId.length > 512 ||
    !/^[1-9]\d{0,14}$/.test(generation)
  ) {
    return 'invalid';
  }
  return { userId, connectionId, connectionGeneration: Number(generation) };
}
