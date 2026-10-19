import { Button } from '@ui/Button';
import {
  authClient,
  createCloudflareReturnURL,
  requestEmailSignInLink,
  signInWithCloudflare,
  signInWithGoogle,
} from '~/lib/auth-client';
import { recordReauthenticatingUser } from '~/lib/stores/reauthentication';

/**
 * A fresh sign-in, the way the person signs in: Cloudflare, Google, or a link to their own email. Any of
 * them creates the new session that export, erasure and connecting Cloudflare ask for, and returns here.
 */
export function ReauthenticateButtons({
  onError,
  onLinkSent,
}: {
  onError: (message: string | null) => void;
  onLinkSent: (email: string) => void;
}) {
  const { data: session } = authClient.useSession();

  const reauthenticate = async (method: 'cloudflare' | 'google' | 'email') => {
    onError(null);
    const returnTo = createCloudflareReturnURL(window.location.href);
    if (session) {
      recordReauthenticatingUser(session.user.id);
    }
    try {
      if (method === 'cloudflare') {
        await signInWithCloudflare(returnTo);
      } else if (method === 'google') {
        await signInWithGoogle(returnTo);
      } else if (session) {
        await requestEmailSignInLink(session.user.email, returnTo);
        onLinkSent(session.user.email);
      }
    } catch (authorizationError) {
      onError(authorizationError instanceof Error ? authorizationError.message : 'Unable to sign in again.');
    }
  };

  return (
    <>
      {/* Only for someone who signs in with Cloudflare: for anyone else it would attach a Cloudflare login. */}
      {session?.contexts.some((option) => option.kind === 'personal') ? (
        <Button size="sm" variant="neutral" onClick={() => void reauthenticate('cloudflare')}>
          Reconnect Cloudflare
        </Button>
      ) : null}
      <Button size="sm" variant="neutral" onClick={() => void reauthenticate('google')}>
        Continue with Google
      </Button>
      {session ? (
        <Button size="sm" variant="neutral" onClick={() => void reauthenticate('email')}>
          Email me a sign-in link
        </Button>
      ) : null}
    </>
  );
}
