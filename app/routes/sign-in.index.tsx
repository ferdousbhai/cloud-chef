import { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';
import { Loading } from '~/components/Loading';
import { authClient } from '~/lib/auth-client';
import { createPrivatePageHead } from '~/lib/social-meta';

/**
 * Signing in without describing an app first: with Cloudflare (to build in your own account), or with
 * Google or an emailed link (to build in an organization's). Signed in already, it goes to the builder.
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
  return (
    <CloudflareSignInPrompt
      title="Sign in to CloudChef."
      description="Use Cloudflare to build in your own account, or Google or an emailed link to build in your team's."
      returnTo="/"
    />
  );
}
