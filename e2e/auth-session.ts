import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';

const personalContext: WorkspaceContext = {
  kind: 'personal',
  connectionId: 'e2e-connection',
  accountName: 'Test account',
};

/**
 * What `/api/auth/session` answers for a signed-in member with their own Cloudflare account, for tests that stub
 * sign-in. Typed against the server contract: the client reads a session without a `context` as signed out, so a
 * stub that drifts from the contract would silently test the signed-out page.
 */
export const authSession: CloudflareAuthSession = {
  session: { id: 'e2e-session', userId: 'e2e-user', expiresAt: Date.now() + 86_400_000, createdAt: Date.now() },
  user: { id: 'e2e-user', name: 'E2E fixture', email: 'e2e@example.invalid', image: null },
  context: personalContext,
  contexts: [personalContext],
};
