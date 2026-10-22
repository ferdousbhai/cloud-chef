import { useState } from 'react';
import { requestEmailSignInLink, signInWithGoogle } from '~/lib/auth-client';
import { messageOf } from '~/lib/json-request';

/**
 * Signing in with Google, or by a link emailed to an address, that returns to `returnTo` (this page by default).
 * `busy` is the way under way; a failure is reported to `onError` as its message, or `failure` when it has none.
 */
export function useGoogleOrEmailSignIn(args: {
  onError: (message: string | null) => void;
  onLinkSent: (email: string) => void;
  failure: string;
}) {
  const [busy, setBusy] = useState<'google' | 'email' | null>(null);
  const run = async (method: 'google' | 'email', action: () => Promise<boolean | void>) => {
    setBusy(method);
    args.onError(null);
    try {
      await action();
    } catch (failure) {
      args.onError(messageOf(failure, args.failure));
    } finally {
      // Google navigates away on success; an emailed link leaves the page here.
      setBusy(null);
    }
  };
  return {
    busy,
    continueWithGoogle: (returnTo?: string) => run('google', () => signInWithGoogle(returnTo)),
    emailLink: (email: string, returnTo?: string) =>
      run('email', async () => {
        await requestEmailSignInLink(email, returnTo);
        args.onLinkSent(email);
      }),
  };
}
