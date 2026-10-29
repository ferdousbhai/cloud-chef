import { useState, type FormEvent, type ReactNode } from 'react';
import { BrandLink } from '~/components/BrandLink';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { LinkButton } from '~/components/ui/LinkButton';
import {
  authClient,
  createCloudflareReturnURL,
  ReauthenticationRequiredError,
  retrySession,
  signInWithCloudflare,
  signOutOfCloudChef,
} from '~/lib/auth-client';
import { useGoogleOrEmailSignIn } from '~/lib/hooks/useGoogleOrEmailSignIn';
import { messageOf } from '~/lib/json-request';
import { CloudflareConnectLegalNotice } from '~/components/CloudflareConnectLegalNotice';
import { ReauthenticatePrompt } from '~/components/settings/ReauthenticatePrompt';
import { classNames } from '~/utils/classNames';

/**
 * What someone sees when a page needs a Cloudflare account to build in. Signed out, they continue with
 * Cloudflare (which makes a CloudChef account if they have none), or sign in to the CloudChef account
 * they already have with Google or an emailed link. Signed in without one, they can connect Cloudflare
 * to their CloudChef account.
 */
export function CloudflareSignInPrompt({
  title,
  description,
  initialError = null,
  returnTo,
}: {
  title: string;
  description?: string;
  initialError?: string | null;
  /** Where signing in returns to; this page by default. */
  returnTo?: string;
}) {
  const returnURL = () =>
    createCloudflareReturnURL(returnTo ? new URL(returnTo, window.location.origin).href : undefined);
  const { data: session, error: sessionError } = authClient.useSession();
  const [busy, setBusy] = useState<'cloudflare' | 'sign-out' | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [email, setEmail] = useState('');
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  const withoutCloudflare = useGoogleOrEmailSignIn({
    onError: setError,
    onLinkSent: setEmailSentTo,
    failure: 'Unable to sign in.',
  });
  // Connecting Cloudflare to a Google or emailed-link account asks for a recent sign-in first.
  const [reauthenticateReason, setReauthenticateReason] = useState<string | null>(null);

  const run = async (kind: 'cloudflare' | 'sign-out', action: () => Promise<boolean>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (failure) {
      if (failure instanceof ReauthenticationRequiredError) {
        setReauthenticateReason(failure.message);
        return;
      }
      const fallback = kind === 'sign-out' ? 'Unable to sign out. Please try again.' : 'Unable to sign in.';
      setError(messageOf(failure, fallback));
    } finally {
      // Connecting Cloudflare and signing out navigate away on success.
      setBusy(null);
    }
  };

  const sendLinkTo = (address: string) => void withoutCloudflare.emailLink(address, returnURL());

  const sendLink = (event: FormEvent) => {
    event.preventDefault();
    sendLinkTo(email.trim());
  };

  if (!session && sessionError) {
    // The session couldn't be checked: offering to sign in would look like being signed out.
    return (
      <PromptCard title={title}>
        <SessionCheckError className="mt-4" />
      </PromptCard>
    );
  }

  return (
    <PromptCard title={title}>
      {description ? <p className="app-page-lede wrap-break-word">{description}</p> : null}
      {session ? (
        <p className="app-page-lede wrap-break-word">
          You&apos;re signed in as <span className="break-all">{session.user.email}</span>. Connect a Cloudflare account
          to build in it, or ask your team&apos;s admin to invite this address.
        </p>
      ) : null}
      {session && reauthenticateReason ? (
        <ReauthenticatePrompt
          className="mt-4 text-sm text-content-secondary"
          reason={reauthenticateReason}
          next="come back here and connect Cloudflare again"
          onError={setError}
        />
      ) : null}
      {error && (
        <p className="mt-4 text-sm text-content-error" role="alert">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          loading={busy === 'cloudflare'}
          onClick={() => void run('cloudflare', () => signInWithCloudflare(returnURL()))}
        >
          {session ? 'Connect Cloudflare' : 'Continue with Cloudflare'}
        </Button>
        {session ? (
          <>
            <LinkButton to="/settings" variant="neutral">
              Teams
            </LinkButton>
            <Button
              variant="neutral"
              loading={busy === 'sign-out'}
              onClick={() => void run('sign-out', () => signOutOfCloudChef())}
            >
              Sign out
            </Button>
          </>
        ) : null}
        <span className="text-xs text-content-secondary">Needs Cloudflare&apos;s Workers Paid plan.</span>
      </div>
      {session ? null : (
        <div className="mt-6 border-t border-bolt-elements-borderColor pt-4">
          <p className="wrap-break-word text-sm text-content-secondary">
            Or sign in with Google or an emailed link.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="neutral"
              loading={withoutCloudflare.busy === 'google'}
              onClick={() => void withoutCloudflare.continueWithGoogle(returnURL())}
            >
              Continue with Google
            </Button>
          </div>
          {emailSentTo ? (
            <>
              <p className="mt-3 wrap-break-word text-sm text-content-secondary" role="status">
                We sent an email to <span className="break-all">{emailSentTo}</span>. Open its sign-in link in this
                browser; it works once, for 15 minutes.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="neutral"
                  loading={withoutCloudflare.busy === 'email'}
                  onClick={() => sendLinkTo(emailSentTo)}
                >
                  Resend
                </Button>
                <Button
                  variant="subtle"
                  disabled={withoutCloudflare.busy === 'email'}
                  onClick={() => setEmailSentTo(null)}
                >
                  Use a different address
                </Button>
              </div>
            </>
          ) : (
            <form className="mt-3 flex flex-wrap gap-2" onSubmit={sendLink}>
              <TextInput
                type="email"
                required
                autoComplete="email"
                placeholder="you@company.com"
                aria-label="Email address"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="min-w-0 flex-1"
              />
              <Button type="submit" variant="neutral" loading={withoutCloudflare.busy === 'email'}>
                Email me a link
              </Button>
            </form>
          )}
        </div>
      )}
      <CloudflareConnectLegalNotice className="mt-6" planNote={false} />
    </PromptCard>
  );
}

function PromptCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <section className="app-error-card app-card m-auto shrink-0" aria-labelledby="cloudflare-sign-in-heading">
        <BrandLink />
        <h1 id="cloudflare-sign-in-heading" className="app-page-title mt-4 text-2xl!">
          {title}
        </h1>
        {children}
      </section>
    </div>
  );
}

/** Shown where a sign-in prompt would be when the session couldn't be checked, which isn't being signed out. */
export function SessionCheckError({ className }: { className?: string }) {
  return (
    <p className={classNames('text-sm text-content-error', className)} role="alert">
      Couldn&apos;t check your session.{' '}
      <button type="button" className="font-medium underline" onClick={retrySession}>
        Retry.
      </button>
    </p>
  );
}
