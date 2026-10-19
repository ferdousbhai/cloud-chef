import { useState, type FormEvent } from 'react';
import { ArrowLeftIcon } from '@radix-ui/react-icons';
import { BrandLink } from '~/components/BrandLink';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { LinkButton } from '~/components/ui/LinkButton';
import {
  authClient,
  createCloudflareReturnURL,
  requestEmailSignInLink,
  signInWithCloudflare,
  signInWithGoogle,
  signOutOfCloudChef,
} from '~/lib/auth-client';
import { CloudflareConnectLegalNotice } from '~/components/CloudflareConnectLegalNotice';

/**
 * What someone sees when a page needs a Cloudflare account to build in. Signed out, they can sign in
 * with Cloudflare (to build in their own account), or with Google or an emailed link (people without a
 * Cloudflare login). Signed in without one, they can connect Cloudflare to their CloudChef account.
 */
export function CloudflareSignInPrompt({
  title,
  description,
  initialError = null,
}: {
  title: string;
  description?: string;
  initialError?: string | null;
}) {
  const { data: session } = authClient.useSession();
  const [busy, setBusy] = useState<'cloudflare' | 'google' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [email, setEmail] = useState('');
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);

  const run = async (kind: 'cloudflare' | 'google' | 'email', action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to sign in.');
    } finally {
      // Cloudflare and Google navigate away on success; the email form stays.
      setBusy(null);
    }
  };

  const sendLink = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    void run('email', async () => {
      await requestEmailSignInLink(address, createCloudflareReturnURL());
      setEmailSentTo(address);
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <section className="app-error-card app-card m-auto shrink-0" aria-labelledby="cloudflare-sign-in-heading">
        <BrandLink />
        <h1 id="cloudflare-sign-in-heading" className="app-page-title mt-4 !text-2xl">
          {title}
        </h1>
        {description ? <p className="app-page-lede">{description}</p> : null}
        {session ? (
          <p className="app-page-lede">
            You&apos;re signed in as {session.user.email}. Connect a Cloudflare account to build in it, or ask your
            organization&apos;s admin to invite this address.
          </p>
        ) : null}
        {error && (
          <p className="mt-4 text-sm text-content-error" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            loading={busy === 'cloudflare'}
            onClick={() => void run('cloudflare', () => signInWithCloudflare(createCloudflareReturnURL()))}
          >
            Connect Cloudflare
          </Button>
          {session ? (
            <>
              <LinkButton to="/settings" variant="neutral">
                Create an organization
              </LinkButton>
              <Button variant="neutral" onClick={() => void signOutOfCloudChef()}>
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
            <p className="text-sm text-content-secondary">No Cloudflare login? Sign in to join your organization.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="neutral"
                loading={busy === 'google'}
                onClick={() => void run('google', () => signInWithGoogle(createCloudflareReturnURL()))}
              >
                Continue with Google
              </Button>
            </div>
            {emailSentTo ? (
              <p className="mt-3 text-sm text-content-secondary" role="status">
                Check {emailSentTo} for a sign-in link. It works once, for 15 minutes.
              </p>
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
      </section>
    </div>
  );
}
