import { useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeftIcon } from '@radix-ui/react-icons';
import { BrandLink } from '~/components/BrandLink';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { LinkButton } from '~/components/ui/LinkButton';
import {
  authClient,
  createCloudflareReturnURL,
  ReauthenticationRequiredError,
  requestEmailSignInLink,
  retrySession,
  signInWithCloudflare,
  signInWithGoogle,
  signOutOfCloudChef,
} from '~/lib/auth-client';
import { CloudflareConnectLegalNotice } from '~/components/CloudflareConnectLegalNotice';
import { ReauthenticateButtons } from '~/components/settings/ReauthenticateButtons.client';
import { classNames } from '~/utils/classNames';

/**
 * What someone sees when a page needs a Cloudflare account to build in. Signed out, they can sign in
 * with Cloudflare (to build in their own account), or with Google or an emailed link (people without a
 * Cloudflare login). Signed in without one, they can connect Cloudflare to their CloudChef account.
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
  const [busy, setBusy] = useState<'cloudflare' | 'google' | 'email' | 'sign-out' | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [email, setEmail] = useState('');
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  // Connecting Cloudflare to a Google or emailed-link account asks for a recent sign-in first.
  const [reauthenticateReason, setReauthenticateReason] = useState<string | null>(null);
  const [reauthenticationLinkSentTo, setReauthenticationLinkSentTo] = useState<string | null>(null);

  const run = async (kind: 'cloudflare' | 'google' | 'email' | 'sign-out', action: () => Promise<void>) => {
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
      setError(failure instanceof Error ? failure.message : fallback);
    } finally {
      // Cloudflare, Google and signing out navigate away on success; the email form stays.
      setBusy(null);
    }
  };

  const sendLinkTo = (address: string) =>
    void run('email', async () => {
      await requestEmailSignInLink(address, returnURL());
      setEmailSentTo(address);
    });

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
      {description ? <p className="app-page-lede break-words">{description}</p> : null}
      {session ? (
        <p className="app-page-lede break-words">
          You&apos;re signed in as <span className="break-all">{session.user.email}</span>. Connect a Cloudflare account
          to build in it, or ask your team&apos;s admin to invite this address.
        </p>
      ) : null}
      {session && reauthenticateReason ? (
        <div role="status" className="mt-4 text-sm text-content-secondary">
          <p>
            {reauthenticationLinkSentTo
              ? `Open the link sent to ${reauthenticationLinkSentTo}, then come back here and connect Cloudflare again.`
              : reauthenticateReason}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <ReauthenticateButtons onError={setError} onLinkSent={setReauthenticationLinkSentTo} />
          </div>
        </div>
      ) : null}
      {error && (
        <p className="mt-4 text-sm text-content-error" role="alert">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          loading={busy === 'cloudflare'}
          onClick={() => void run('cloudflare', () => signInWithCloudflare(returnURL()))}
        >
          Connect Cloudflare
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
        ) : (
          <LinkButton to="/" variant="neutral" icon={<ArrowLeftIcon aria-hidden />}>
            Back to CloudChef
          </LinkButton>
        )}
      </div>
      {session ? null : (
        <div className="mt-6 border-t border-bolt-elements-borderColor pt-4">
          <p className="text-sm text-content-secondary">No Cloudflare login? Sign in to join your team.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="neutral"
              loading={busy === 'google'}
              onClick={() => void run('google', () => signInWithGoogle(returnURL()))}
            >
              Continue with Google
            </Button>
          </div>
          {emailSentTo ? (
            <>
              <p className="mt-3 break-words text-sm text-content-secondary" role="status">
                Check <span className="break-all">{emailSentTo}</span> for a sign-in link, and open it in this browser.
                It works once, for 15 minutes.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="neutral" loading={busy === 'email'} onClick={() => sendLinkTo(emailSentTo)}>
                  Resend
                </Button>
                <Button variant="subtle" disabled={busy === 'email'} onClick={() => setEmailSentTo(null)}>
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
              <Button type="submit" variant="neutral" loading={busy === 'email'}>
                Email me a link
              </Button>
            </form>
          )}
        </div>
      )}
      <CloudflareConnectLegalNotice className="mt-4" />
    </PromptCard>
  );
}

function PromptCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <section className="app-error-card app-card m-auto shrink-0" aria-labelledby="cloudflare-sign-in-heading">
        <BrandLink />
        <h1 id="cloudflare-sign-in-heading" className="app-page-title mt-4 !text-2xl">
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
