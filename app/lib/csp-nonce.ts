import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';

export const CSP_NONCE_REQUEST_HEADER = 'X-CloudChef-CSP-Nonce';
const CSP_NONCE_PATTERN = /^[0-9a-f-]{36}$/i;

export const contentSecurityPolicyNonce = createIsomorphicFn()
  .server(() => requireValidNonce(getRequestHeader(CSP_NONCE_REQUEST_HEADER)))
  .client(() => requireValidNonce(document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.content));

function requireValidNonce(value: string | null | undefined): string {
  if (!value || !CSP_NONCE_PATTERN.test(value)) {
    throw new Error('The request is missing its content security policy nonce.');
  }
  return value;
}
