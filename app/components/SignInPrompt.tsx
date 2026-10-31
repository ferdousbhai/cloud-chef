import { useState, type FormEvent, type ReactNode } from 'react';
import { BrandLink } from '~/components/BrandLink';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { TextInput } from '@ui/TextInput';
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
import { ChooseUsernamePrompt } from '~/components/settings/UsernameForm';
import { classNames } from '~/utils/classNames';

/**
 * What someone sees when a page needs them signed in, or signed in with somewhere to build. Signed out, they
 * sign in with Google or an emailed link, which makes a CloudChef account if they have none; an account first
 * made with Cloudflare signs in with it from a small link. Signed in with nowhere to build yet, they choose
 * where their apps live (`ChooseSpace`).
 */
export function SignInPrompt({
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
  const { data: session, error: sessionError } = authClient.useSession();

  if (!session && sessionError) {
    // The session couldn't be checked: offering to sign in would look like being signed out.
    return (
      <PromptCard title={title}>
        <SessionCheckError className="mt-4" />
      </PromptCard>
    );
  }
  if (session) {
    return (
      <PromptCard title="Where should your apps live?">
        <ChooseSpace initialError={initialError} returnTo={returnTo} />
        <ChooseUsernamePrompt />
      </PromptCard>
    );
  }
  return (
    <PromptCard title={title}>
      {description ? <p className="app-page-lede wrap-break-word">{description}</p> : null}
      <SignInOptions initialError={initialError} returnTo={returnTo} />
    </PromptCard>
  );
}

const LAST_SIGN_IN_KEY = 'cloudchef:last-sign-in';
type SignInMethod = 'google' | 'email' | 'cloudflare';

/** How this browser signed in last, so the page can mark it; kept only in this browser. */
function readLastSignIn(): SignInMethod | null {
  try {
    const stored = window.localStorage.getItem(LAST_SIGN_IN_KEY);
    return stored === 'google' || stored === 'email' || stored === 'cloudflare' ? stored : null;
  } catch {
    return null;
  }
}

function rememberSignIn(method: SignInMethod): void {
  try {
    window.localStorage.setItem(LAST_SIGN_IN_KEY, method);
  } catch {
    // Marking the last way in is a convenience; signing in works without it.
  }
}

function returnURLFor(returnTo: string | undefined): string {
  return createCloudflareReturnURL(returnTo ? new URL(returnTo, window.location.origin).href : undefined);
}

/**
 * Signing in, the same for everyone: Google, or a link emailed to any address. Either one makes an account for
 * someone new, and the page never says whether an address has one.
 */
export function SignInOptions({ initialError = null, returnTo }: { initialError?: string | null; returnTo?: string }) {
  const [error, setError] = useState<string | null>(initialError);
  const [email, setEmail] = useState('');
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [lastUsed] = useState(readLastSignIn);
  const signIn = useGoogleOrEmailSignIn({
    onError: setError,
    onLinkSent: setEmailSentTo,
    failure: 'Unable to sign in.',
  });

  const sendLinkTo = (address: string) => {
    rememberSignIn('email');
    void signIn.emailLink(address, returnURLFor(returnTo));
  };
  const sendLink = (event: FormEvent) => {
    event.preventDefault();
    sendLinkTo(email.trim());
  };
  const continueWithGoogle = () => {
    rememberSignIn('google');
    void signIn.continueWithGoogle(returnURLFor(returnTo));
  };
  const continueWithCloudflare = async () => {
    rememberSignIn('cloudflare');
    setConnecting(true);
    setError(null);
    try {
      await signInWithCloudflare(returnURLFor(returnTo));
    } catch (failure) {
      setError(messageOf(failure, 'Unable to sign in.'));
    } finally {
      // Signing in navigates away on success.
      setConnecting(false);
    }
  };

  return (
    <div className="mt-5 grid gap-3">
      {error ? (
        <p className="text-sm text-content-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        size="lg"
        className="relative w-full"
        loading={signIn.busy === 'google'}
        onClick={continueWithGoogle}
        icon={<GoogleMark />}
      >
        Continue with Google
        {lastUsed === 'google' ? <LastUsed /> : null}
      </Button>
      <div className="flex items-center gap-3 text-xs text-content-tertiary" aria-hidden>
        <span className="h-px flex-1 bg-bolt-elements-borderColor" />
        or
        <span className="h-px flex-1 bg-bolt-elements-borderColor" />
      </div>
      {emailSentTo ? (
        <div className="grid gap-3">
          <p className="wrap-break-word text-sm text-content-secondary" role="status">
            Check your email. We sent a sign-in link to <span className="break-all">{emailSentTo}</span>; open it in
            this browser within 15 minutes.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="neutral" loading={signIn.busy === 'email'} onClick={() => sendLinkTo(emailSentTo)}>
              Send it again
            </Button>
            <Button variant="subtle" disabled={signIn.busy === 'email'} onClick={() => setEmailSentTo(null)}>
              Use a different email
            </Button>
          </div>
        </div>
      ) : (
        <form className="grid gap-2" onSubmit={sendLink}>
          <TextInput
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            aria-label="Email address"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button
            type="submit"
            size="lg"
            variant="neutral"
            className="relative w-full"
            loading={signIn.busy === 'email'}
          >
            Continue with email
            {lastUsed === 'email' ? <LastUsed /> : null}
          </Button>
        </form>
      )}
      <p className="mt-2 text-center text-xs text-content-tertiary">
        Made your account with Cloudflare?{' '}
        <button
          type="button"
          className="font-medium text-content-secondary underline hover:text-content-primary disabled:opacity-50"
          disabled={connecting}
          onClick={() => void continueWithCloudflare()}
        >
          Sign in with Cloudflare
        </button>
        {lastUsed === 'cloudflare' ? ' (last used)' : null}
      </p>
      <CloudflareConnectLegalNotice className="mt-2 text-center" planNote={false} />
    </div>
  );
}

function LastUsed() {
  return (
    <span className="absolute right-2 rounded-full bg-black/15 px-2 py-0.5 text-[11px] font-medium">Last used</span>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4 rounded-full bg-white p-0.5">
      <path
        fill="#4285F4"
        d="M22.5 12.3c0-.8-.1-1.5-.2-2.3H12v4.3h5.9a5 5 0 0 1-2.2 3.3v2.8h3.6c2-1.9 3.2-4.7 3.2-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.9A11 11 0 0 0 12 23z"
      />
      <path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7H2.1a11 11 0 0 0 0 10z" />
      <path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7l3.7 2.9C6.7 7.3 9.1 5.4 12 5.4z" />
    </svg>
  );
}

/**
 * Signed in with nowhere to build yet: the ways a person's apps can live, simplest first. A team's space needs
 * its admin's invitation, which brings them straight in; their own Cloudflare account they connect here. When
 * CloudChef runs spaces itself (docs/proposals/managed-spaces.md), that becomes the first choice.
 */
export function ChooseSpace({
  initialError = null,
  returnTo,
  continuePrompt,
}: {
  initialError?: string | null;
  returnTo?: string;
  /** What the person asked to build, finished once their account is connected. */
  continuePrompt?: string;
}) {
  const { data: session } = authClient.useSession();
  const [busy, setBusy] = useState<'cloudflare' | 'sign-out' | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  // What happens on Cloudflare's site is said before going there, so its pages aren't a surprise.
  const [showCloudflareSteps, setShowCloudflareSteps] = useState(false);
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
      const fallback = kind === 'sign-out' ? 'Unable to sign out. Please try again.' : 'Unable to connect.';
      setError(messageOf(failure, fallback));
    } finally {
      // Connecting and signing out navigate away on success.
      setBusy(null);
    }
  };

  if (!session) {
    return null;
  }
  return (
    <div className="mt-4 grid gap-3">
      <p className="app-page-lede wrap-break-word">
        You&apos;re signed in as <span className="break-all">{session.user.email}</span>. Choose where the apps you
        build will run.
      </p>
      {error ? (
        <p className="text-sm text-content-error" role="alert">
          {error}
        </p>
      ) : null}
      {reauthenticateReason ? (
        <ReauthenticatePrompt
          className="text-sm text-content-secondary"
          reason={reauthenticateReason}
          next="come back here and choose again"
          onError={setError}
        />
      ) : null}
      <SpaceChoice title="In your team's space">
        If your team builds with CloudChef, ask its admin to invite{' '}
        <span className="break-all">{session.user.email}</span>. The invitation&apos;s link brings you straight in.
      </SpaceChoice>
      <SpaceChoice
        title="In your own Cloudflare account"
        details={showCloudflareSteps ? <CloudflareSteps continuing={continuePrompt !== undefined} /> : null}
        action={
          showCloudflareSteps ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                loading={busy === 'cloudflare'}
                onClick={() =>
                  void run('cloudflare', () =>
                    signInWithCloudflare(returnURLFor(returnTo), continuePrompt ? { continuePrompt } : undefined),
                  )
                }
              >
                Continue to Cloudflare
              </Button>
              <Button variant="neutral" disabled={busy === 'cloudflare'} onClick={() => setShowCloudflareSteps(false)}>
                Back
              </Button>
            </div>
          ) : (
            <Button variant="neutral" onClick={() => setShowCloudflareSteps(true)}>
              Use my Cloudflare account
            </Button>
          )
        }
      >
        Your apps, their data and the AI that builds them run in your account, and Cloudflare bills you for them.
      </SpaceChoice>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-content-tertiary">
        <CloudflareConnectLegalNotice planNote={false} />
        <button
          type="button"
          className="font-medium text-content-secondary underline hover:text-content-primary disabled:opacity-50"
          disabled={busy === 'sign-out'}
          onClick={() => void run('sign-out', () => signOutOfCloudChef())}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

/** The trip to Cloudflare's site and back, in the order it happens. */
function CloudflareSteps({ continuing }: { continuing: boolean }) {
  return (
    <div className="grid gap-2 rounded-md bg-bolt-elements-background-depth-2 p-3">
      <h3 className="text-sm font-semibold text-content-primary">What happens next</h3>
      <ol className="grid list-decimal gap-1.5 pl-5 text-sm text-content-secondary">
        <li>Sign in to Cloudflare, or make a free account there.</li>
        <li>
          Turn on Cloudflare&apos;s Workers Paid plan if it isn&apos;t on yet. It starts at $5 a month, billed by
          Cloudflare.
        </li>
        <li>Approve CloudChef. You come straight back here.</li>
      </ol>
      <p className="text-sm text-content-secondary">
        Back here, CloudChef sets up your space, which takes a few minutes the first time.
        {continuing ? ' Then what you asked for starts building.' : null}
      </p>
    </div>
  );
}

function SpaceChoice({
  title,
  details,
  action,
  children,
}: {
  title: string;
  details?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2 rounded-lg border border-bolt-elements-borderColor p-4">
      <h2 className="text-sm font-semibold text-content-primary">{title}</h2>
      <p className="wrap-break-word text-sm text-content-secondary">{children}</p>
      {details}
      {action ? <div>{action}</div> : null}
    </section>
  );
}

function PromptCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <section className="app-error-card app-card m-auto shrink-0" aria-labelledby="sign-in-heading">
        <BrandLink />
        <h1 id="sign-in-heading" className="app-page-title mt-4 text-2xl!">
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

/**
 * Signing in, or choosing where to build, over the page someone is on: the home's prompt opens it, keeping what
 * they typed. A submit that opened it is finished once their own Cloudflare account is connected.
 */
export function SignInDialog({ continuePrompt, onClose }: { continuePrompt?: string; onClose: () => void }) {
  const { data: session } = authClient.useSession();
  return (
    <Modal title={session ? 'Where should your apps live?' : 'Sign in to CloudChef'} onClose={onClose}>
      {session ? (
        <ChooseSpace continuePrompt={continuePrompt} />
      ) : (
        <SignInOptions returnTo={window.location.pathname} />
      )}
    </Modal>
  );
}
