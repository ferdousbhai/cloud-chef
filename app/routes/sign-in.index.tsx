import { useEffect } from 'react';
import { z } from 'zod';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';
import { Loading } from '~/components/Loading';
import { authClient } from '~/lib/auth-client';
import { NO_ACCOUNT_MESSAGE, NO_ACCOUNT_REFUSAL, SIGN_IN_REFUSAL_PARAM } from '~/lib/sign-in-refusal';
import { createPrivatePageHead } from '~/lib/social-meta';

const signInSearchSchema = z.object({ [SIGN_IN_REFUSAL_PARAM]: z.string().optional().catch(undefined) });

/**
 * Signing in without describing an app first: with Cloudflare, to build in your own account (and make a
 * CloudChef account if you have none), or with Google or an emailed link, to the CloudChef account you
 * have. Signed in already, it goes to the builder. A Google sign-in with no account comes back here,
 * naming why in the URL; only CloudChef's own text for it is shown.
 */
export const Route = createFileRoute('/sign-in/')({
  validateSearch: signInSearchSchema,
  head: () => createPrivatePageHead('Sign in | CloudChef', 'Sign in to CloudChef.'),
  component: SignIn,
});

function SignIn() {
  const { data: session, isPending } = authClient.useSession();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const signedIn = session !== null && session.context !== null;

  useEffect(() => {
    if (signedIn) {
      void navigate({ to: '/' });
    }
  }, [signedIn, navigate]);

  if (isPending || signedIn) {
    return <Loading message="Checking your session…" />;
  }
  return (
    <CloudflareSignInPrompt
      title="Sign in to CloudChef."
      description="Build in your own Cloudflare account, or in a team you've joined."
      initialError={search[SIGN_IN_REFUSAL_PARAM] === NO_ACCOUNT_REFUSAL ? NO_ACCOUNT_MESSAGE : null}
      returnTo="/"
    />
  );
}
