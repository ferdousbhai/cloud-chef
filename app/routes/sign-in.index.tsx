import { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { SignInPrompt } from '~/components/SignInPrompt';
import { Loading } from '~/components/Loading';
import { authClient } from '~/lib/auth-client';
import { createPrivatePageHead } from '~/lib/social-meta';

/**
 * Signing in without describing an app first, with Google or an emailed link (an account made with Cloudflare
 * signs in with it). Signed in with somewhere to build already, it goes to the builder; signed in with nowhere
 * yet, it asks where their apps should live.
 */
export const Route = createFileRoute('/sign-in/')({
  head: () => createPrivatePageHead('Sign in | CloudChef', 'Sign in to CloudChef.'),
  component: SignIn,
});

function SignIn() {
  const { data: session, isPending } = authClient.useSession();
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
  return <SignInPrompt title="Sign in to CloudChef" returnTo="/" />;
}
