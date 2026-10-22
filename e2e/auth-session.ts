/** What `/api/auth/session` answers for a signed-in member, for tests that stub sign-in. */
export const authSession = {
  session: { id: 'e2e-session', userId: 'e2e-user', expiresAt: Date.now() + 86_400_000, createdAt: Date.now() },
  user: { id: 'e2e-user', name: 'E2E fixture', email: 'e2e@example.invalid', image: null },
};
