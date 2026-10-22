import { useState, type ReactNode } from 'react';
import { Button } from '@ui/Button';
import { authClient, createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';
import { useGoogleOrEmailSignIn } from '~/lib/hooks/useGoogleOrEmailSignIn';
import { messageOf } from '~/lib/json-request';
import { recordReauthenticatingUser } from '~/lib/stores/reauthentication';
import { classNames } from '~/utils/classNames';

/**
 * An action that asks for a recent sign-in: why, the ways to sign in again, and, once an emailed link is
 * sent, where to open it. `children` are further buttons beside the sign-in ones.
 */
export function ReauthenticatePrompt({
  reason,
  next,
  onError,
  className,
  children,
}: {
  /** Why a sign-in is asked for, until a link is sent. */
  reason: string;
  /** What to do after opening an emailed link: "Open the link sent to …, then {next}." */
  next: string;
  onError: (message: string | null) => void;
  className?: string;
  children?: ReactNode;
}) {
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
  return (
    <div role="status" className={classNames('grid gap-2', className)}>
      <p>{linkSentTo ? `Open the link sent to ${linkSentTo}, then ${next}.` : reason}</p>
      <div className="flex flex-wrap gap-2">
        <ReauthenticateButtons onError={onError} onLinkSent={setLinkSentTo} />
        {children}
      </div>
    </div>
  );
}

/**
 * A fresh sign-in, the way the person signs in: Cloudflare, Google, or a link to their own email. Any of
 * them creates the new session that export, erasure and connecting Cloudflare ask for, and returns here.
 */
function ReauthenticateButtons({
  onError,
  onLinkSent,
}: {
  onError: (message: string | null) => void;
  onLinkSent: (email: string) => void;
}) {
  const { data: session } = authClient.useSession();
  const { continueWithGoogle, emailLink } = useGoogleOrEmailSignIn({
    onError,
    onLinkSent,
    failure: 'Unable to sign in again.',
  });

  /** Where the new sign-in returns to, noting who is signing in again so the return can tell. */
  const returnTo = () => {
    if (session) {
      recordReauthenticatingUser(session.user.id);
    }
    return createCloudflareReturnURL(window.location.href);
  };

  const reconnectCloudflare = async () => {
    onError(null);
    try {
      await signInWithCloudflare(returnTo());
    } catch (authorizationError) {
      onError(messageOf(authorizationError, 'Unable to sign in again.'));
    }
  };

  return (
    <>
      {/* Only for someone who signs in with Cloudflare: for anyone else it would attach a Cloudflare login. */}
      {session?.contexts.some((option) => option.kind === 'personal') ? (
        <Button size="sm" variant="neutral" onClick={() => void reconnectCloudflare()}>
          Reconnect Cloudflare
        </Button>
      ) : null}
      <Button size="sm" variant="neutral" onClick={() => void continueWithGoogle(returnTo())}>
        Continue with Google
      </Button>
      {session ? (
        <Button size="sm" variant="neutral" onClick={() => void emailLink(session.user.email, returnTo())}>
          Email me a sign-in link
        </Button>
      ) : null}
    </>
  );
}
