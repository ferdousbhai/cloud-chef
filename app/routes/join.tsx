import { useState } from 'react';
import { z } from 'zod';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@ui/Button';
import { BrandLink } from '~/components/BrandLink';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';
import { Loading } from '~/components/Loading';
import { authClient, requestEmailSignInLink, signInWithGoogle, signOutOfCloudChef } from '~/lib/auth-client';
import { disposeClientCollections } from '~/lib/cloudflare/client-collections';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { createPrivatePageHead } from '~/lib/social-meta';

const joinSearchSchema = z.object({ token: z.string().optional().catch(undefined) });
const errorSchema = z.looseObject({
  error: z.string().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
});

/**
 * Where an organization invite lands. Signing in comes first (Google, an emailed link, or Cloudflare),
 * with the address the invite was sent to; then one click joins, and the builder opens in the
 * organization's Cloudflare account.
 */
export const Route = createFileRoute('/join')({
  validateSearch: joinSearchSchema,
  head: () => createPrivatePageHead('Join an organization | CloudChef', 'Accept an invite to build with your team.'),
  component: Join,
});

function Join() {
  const { token } = Route.useSearch();
  const { data: session, isPending } = authClient.useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This invite link is incomplete.');
  // Refused because CloudChef hasn't proven this account's email yet (it came from a Cloudflare login), though
  // it is the invited address: proving it now, while signed in, keeps it one account instead of starting another.
  const [needsProof, setNeedsProof] = useState(false);
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);

  if (isPending) {
    return <Loading message="Checking your session…" />;
  }
  if (!session) {
    return (
      <CloudflareSignInPrompt
        title="Sign in to accept your invite."
        description="Use the email address the invite was sent to."
      />
    );
  }

  const prove = async (method: 'google' | 'email') => {
    setError(null);
    try {
      if (method === 'google') {
        await signInWithGoogle(window.location.href);
      } else {
        await requestEmailSignInLink(session.user.email, window.location.href);
        setLinkSentTo(session.user.email);
      }
    } catch (proofError) {
      setError(proofError instanceof Error ? proofError.message : 'Unable to confirm your email.');
    }
  };

  const join = async () => {
    if (!token) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/organizations/accept', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        const parsed = errorSchema.safeParse(await response.json().catch(() => null));
        setNeedsProof(parsed.success && parsed.data.code === 'email_unproven');
        throw new Error((parsed.success ? parsed.data.error : undefined) ?? 'Unable to accept this invite.');
      }
      // The builder reopens in the organization's account, with nothing left over from the last one.
      await disposeClientCollections();
      resetUserRuntimeSession();
      window.location.assign('/');
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Unable to accept this invite.');
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <section className="app-error-card app-card m-auto shrink-0" aria-labelledby="join-heading">
        <BrandLink />
        <h1 id="join-heading" className="app-page-title mt-4 !text-2xl">
          Join your organization on CloudChef
        </h1>
        <p className="app-page-lede">
          You&apos;re signed in as {session.user.email}. What you build is stored in the organization&apos;s Cloudflare
          account, where its administrators can see it.
        </p>
        {error && (
          <p className="mt-4 text-sm text-content-error" role="alert">
            {error}
          </p>
        )}
        {needsProof ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="neutral" onClick={() => void prove('google')}>
              Continue with Google
            </Button>
            <Button variant="neutral" onClick={() => void prove('email')}>
              Email me a link to {session.user.email}
            </Button>
          </div>
        ) : null}
        {linkSentTo ? (
          <p className="mt-2 text-sm text-content-secondary" role="status">
            Open the link sent to {linkSentTo} in this browser, then join.
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button loading={busy} disabled={!token} onClick={() => void join()}>
            Join
          </Button>
          <Button variant="neutral" onClick={() => void signOutOfCloudChef(window.location.href)}>
            Use another account
          </Button>
        </div>
      </section>
    </div>
  );
}
