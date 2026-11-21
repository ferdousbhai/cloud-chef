import { useEffect, useState } from 'react';
import { authClient, signInWithGoogle } from '~/lib/auth-client';
import {
  accountNoticeReturnURL,
  pageHasParam,
  PROVE_ADDRESS_WITH_GOOGLE,
  PROVE_ADDRESS_WITH_PARAM,
} from '~/lib/sign-in-account-notice';

/**
 * The last step for someone whose Google address already had an account made with Cloudflare: back from
 * Cloudflare and signed in, they go through Google once more, which proves the address on that account, so
 * Google opens it from then on. A page without the parameter asks nothing, the session included.
 */
export function ProveAddressAfterCloudflare() {
  const [asked] = useState(() => pageHasParam(PROVE_ADDRESS_WITH_PARAM, PROVE_ADDRESS_WITH_GOOGLE));
  return asked ? <ProveWithGoogle /> : null;
}

function ProveWithGoogle() {
  const { data: session, isPending } = authClient.useSession();
  const signedIn = Boolean(session);

  useEffect(() => {
    if (isPending) {
      return;
    }
    const returnTo = accountNoticeReturnURL(window.location.href, false);
    // Taken off the address first, so coming back, or Google failing to start, never starts it again.
    window.history.replaceState(window.history.state, '', returnTo);
    if (signedIn) {
      void signInWithGoogle(returnTo).catch(() => {
        // They are signed in either way; Google can be tried again from the sign-in page another time.
      });
    }
  }, [signedIn, isPending]);

  return null;
}
