import { useEffect, useState } from 'react';
import { z } from 'zod';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@ui/Button';
import { BrandLink } from '~/components/BrandLink';
import { LinkButton } from '~/components/ui/LinkButton';
import { completeEmailSignIn, describeEmailSignIn, signInWithCloudflare } from '~/lib/auth-client';
import { createPrivatePageHead } from '~/lib/social-meta';
import { messageOf, RequestError } from '~/lib/json-request';
import { ACCOUNT_MADE_WITH_CLOUDFLARE_CODE } from '~/lib/sign-in-account-notice';

const emailSignInSearchSchema = z.object({ token: z.string().optional().catch(undefined) });

/**
 * Where an emailed sign-in link lands. Signing in takes a click: mail scanners fetch links but don't
 * press buttons, so they can't use up the one-time link before its owner does.
 */
export const Route = createFileRoute('/sign-in/email')({
  validateSearch: emailSignInSearchSchema,
  head: () => createPrivatePageHead('Sign in | CloudChef', 'Finish signing in to CloudChef.'),
  component: EmailSignIn,
});

function EmailSignIn() {
  const { token } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This sign-in link is incomplete.');
  // Who the link signs in as, shown before the click: a link someone else asked for, for their own
  // address, would otherwise sign you into their account.
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    if (token) {
      void (async () => {
        try {
          const address = await describeEmailSignIn(token);
          if (!canceled) {
            setEmail(address);
          }
        } catch (failure) {
          if (!canceled) {
            setError(messageOf(failure, 'This sign-in link is not valid.'));
          }
        }
      })();
    }
    return () => {
      canceled = true;
    };
  }, [token]);

  // The address already has an account made with Cloudflare: the link is kept, and after signing in with
  // Cloudflare this page's button proves the address on that account.
  const [madeWithCloudflare, setMadeWithCloudflare] = useState(false);

  const signIn = async (options: { separateAccount?: boolean } = {}) => {
    if (!token) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      window.location.assign(await completeEmailSignIn(token, options));
    } catch (failure) {
      if (failure instanceof RequestError && failure.code === ACCOUNT_MADE_WITH_CLOUDFLARE_CODE) {
        setMadeWithCloudflare(true);
      } else {
        setError(messageOf(failure, 'Unable to sign in with this link.'));
      }
      setBusy(false);
    }
  };
  const withCloudflare = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithCloudflare(window.location.href);
    } catch (failure) {
      setError(messageOf(failure, 'Unable to sign in.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <section className="app-error-card app-card m-auto shrink-0" aria-labelledby="email-sign-in-heading">
        <BrandLink />
        <h1 id="email-sign-in-heading" className="app-page-title mt-4 text-2xl!">
          Sign in to CloudChef
        </h1>
        {email ? (
          <p className="app-page-lede wrap-break-word">
            This link signs you in as <strong className="break-all">{email}</strong>. Continue only if that is your
            address.
          </p>
        ) : null}
        {error && (
          <p className="mt-4 text-sm text-content-error" role="alert">
            {error}
          </p>
        )}
        {madeWithCloudflare ? (
          <>
            <p className="mt-4 wrap-break-word text-sm text-content-secondary" role="status">
              That address already has a CloudChef account, made with Cloudflare. Sign in with Cloudflare, then choose
              Sign in on this page again; after that, links emailed to this address open the same account.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button loading={busy} onClick={() => void withCloudflare()}>
                Sign in with Cloudflare
              </Button>
              <Button variant="neutral" disabled={busy} onClick={() => void signIn({ separateAccount: true })}>
                Not my account, make a new one
              </Button>
            </div>
          </>
        ) : email || error ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {email ? (
              <Button loading={busy} onClick={() => void signIn()}>
                Sign in
              </Button>
            ) : null}
            {/* Used, expired or incomplete: the way on is a new link. */}
            {error ? (
              <LinkButton to="/sign-in" variant={email ? 'neutral' : 'primary'}>
                Get a new sign-in link
              </LinkButton>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 text-sm text-content-secondary" role="status">
            Checking your link…
          </p>
        )}
      </section>
    </div>
  );
}
