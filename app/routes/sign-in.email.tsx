import { useEffect, useState } from 'react';
import { z } from 'zod';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@ui/Button';
import { BrandLink } from '~/components/BrandLink';
import { completeEmailSignIn, describeEmailSignIn } from '~/lib/auth-client';
import { createPrivatePageHead } from '~/lib/social-meta';

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
            setError(failure instanceof Error ? failure.message : 'This sign-in link is not valid.');
          }
        }
      })();
    }
    return () => {
      canceled = true;
    };
  }, [token]);

  const signIn = async () => {
    if (!token) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      window.location.assign(await completeEmailSignIn(token));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to sign in with this link.');
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <section className="app-error-card app-card m-auto shrink-0" aria-labelledby="email-sign-in-heading">
        <BrandLink />
        <h1 id="email-sign-in-heading" className="app-page-title mt-4 !text-2xl">
          Sign in to CloudChef
        </h1>
        {email ? (
          <p className="app-page-lede">
            This link signs you in as <strong>{email}</strong>. Continue only if that is your address.
          </p>
        ) : null}
        {error && (
          <p className="mt-4 text-sm text-content-error" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button loading={busy} disabled={!email} onClick={() => void signIn()}>
            Sign in
          </Button>
        </div>
      </section>
    </div>
  );
}
