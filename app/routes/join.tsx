import { useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@ui/Button';
import { BrandLink } from '~/components/BrandLink';
import { SessionCheckError } from '~/components/CloudflareSignInPrompt';
import { Loading } from '~/components/Loading';
import { authClient, requestEmailSignInLink, signInWithGoogle, signOutOfCloudChef } from '~/lib/auth-client';
import { disposeClientCollections } from '~/lib/cloudflare/client-collections';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { createPrivatePageHead } from '~/lib/social-meta';

const joinSearchSchema = z.object({ token: z.string().optional().catch(undefined) });
const acceptedSchema = z.object({ switched: z.boolean() });
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

const inviteSchema = z.object({ orgName: z.string(), email: z.string(), inviterName: z.string() });
type Invite = z.infer<typeof inviteSchema>;

function Join() {
  const { token } = Route.useSearch();
  const { data: session, isPending, error: sessionError } = authClient.useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This invite link is incomplete.');
  // What the link is for: the organization, who sent it, and the address it was emailed to.
  const [invite, setInvite] = useState<Invite | 'invalid' | null>(null);
  // Refused because CloudChef hasn't proven this account's email yet (it came from a Cloudflare login), though
  // it is the invited address: proving it now, while signed in, keeps it one account instead of starting another.
  const [needsProof, setNeedsProof] = useState(false);
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
  const [proving, setProving] = useState<'google' | 'email' | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  // Joined an organization whose admin hasn't connected its Cloudflare account yet: nothing to open there.
  const [joinedWithoutAccount, setJoinedWithoutAccount] = useState(false);
  const joinStarted = useRef(false);

  useEffect(() => {
    if (!token) {
      return;
    }
    void fetch('/api/organizations/invite/describe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        const parsed = inviteSchema.safeParse(await response.json().catch(() => null));
        setInvite(response.ok && parsed.success ? parsed.data : 'invalid');
      })
      .catch(() => setInvite('invalid'));
  }, [token]);

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
      const accepted = acceptedSchema.safeParse(await response.json().catch(() => null));
      if (!accepted.success || !accepted.data.switched) {
        // Still in whatever account they were in: opening the builder would land them in the wrong one.
        setJoinedWithoutAccount(true);
        setBusy(false);
        return;
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

  // Signed in with the invited address (just now, by the link below, or already): join without another click.
  const invitedAddress = invite !== null && invite !== 'invalid' ? invite.email.toLowerCase() : null;
  const signedInAsInvited = session !== null && invitedAddress === session.user.email.toLowerCase();
  useEffect(() => {
    if (signedInAsInvited && !joinStarted.current) {
      joinStarted.current = true;
      void join();
    }
    // `join` reads only the token and stable setters.
  }, [signedInAsInvited]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isPending && !session && sessionError) {
    return (
      <JoinCard title="Join an organization on CloudChef">
        <SessionCheckError className="mt-4" />
      </JoinCard>
    );
  }
  if (isPending || (token && invite === null)) {
    return <Loading message="Opening your invite…" />;
  }
  if (invite === 'invalid' || invite === null) {
    return (
      <JoinCard title="This invite can't be used">
        <p className="app-page-lede">
          {token ? 'It has been used or has expired.' : 'The link is incomplete.'} Ask the person who invited you to
          send a new one.
        </p>
      </JoinCard>
    );
  }
  if (joinedWithoutAccount) {
    return (
      <JoinCard title={`You've joined ${invite.orgName}`}>
        <p className="app-page-lede break-words">
          You&apos;ve joined {invite.orgName}. Its admin hasn&apos;t connected a Cloudflare account yet, so there&apos;s
          nothing to build in there. Once they do, choose {invite.orgName} from your account menu.
        </p>
      </JoinCard>
    );
  }
  if (!session) {
    return (
      <SignInToJoin
        invite={invite}
        onError={setError}
        error={error}
        linkSentTo={linkSentTo}
        onLinkSent={setLinkSentTo}
      />
    );
  }

  const prove = async (method: 'google' | 'email') => {
    setProving(method);
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
    } finally {
      setProving(null);
    }
  };

  const switchToAnotherAccount = async () => {
    setSigningOut(true);
    setError(null);
    try {
      await signOutOfCloudChef(window.location.href);
    } catch (signOutError) {
      setError(signOutError instanceof Error ? signOutError.message : 'Unable to sign out. Please try again.');
      setSigningOut(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <section className="app-error-card app-card m-auto shrink-0" aria-labelledby="join-heading">
        <BrandLink />
        <h1 id="join-heading" className="app-page-title mt-4 !text-2xl">
          Join your organization on CloudChef
        </h1>
        <p className="app-page-lede break-words">
          {invite.inviterName} invited you to {invite.orgName}. You&apos;re signed in as{' '}
          <span className="break-all">{session.user.email}</span>. What you build is stored in the organization&apos;s
          Cloudflare account, where its administrators can see it.
        </p>
        {signedInAsInvited ? null : (
          <p className="mt-2 break-words text-sm text-content-secondary">
            This invite is for <span className="break-all">{invite.email}</span>. Use that account to join.
          </p>
        )}
        {error && (
          <p className="mt-4 text-sm text-content-error" role="alert">
            {error}
          </p>
        )}
        {needsProof && !linkSentTo ? (
          <>
            <p className="mt-4 break-words text-sm text-content-secondary">
              Confirm this address with Google, or with a link emailed to{' '}
              <span className="break-all">{session.user.email}</span>: open it in this browser, then join.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="neutral"
                loading={proving === 'google'}
                disabled={proving !== null}
                onClick={() => void prove('google')}
              >
                Continue with Google
              </Button>
              <Button
                variant="neutral"
                loading={proving === 'email'}
                disabled={proving !== null}
                onClick={() => void prove('email')}
              >
                Email me a link
              </Button>
            </div>
          </>
        ) : null}
        {linkSentTo ? (
          <p className="mt-4 break-words text-sm text-content-secondary" role="status">
            Open the link sent to <span className="break-all">{linkSentTo}</span> in this browser, then join.
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button loading={busy} disabled={!token} onClick={() => void join()}>
            Join
          </Button>
          <Button variant="neutral" loading={signingOut} onClick={() => void switchToAnotherAccount()}>
            Use another account
          </Button>
        </div>
      </section>
    </div>
  );
}

function JoinCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <section className="app-error-card app-card m-auto shrink-0" aria-labelledby="join-heading">
        <BrandLink />
        <h1 id="join-heading" className="app-page-title mt-4 !text-2xl">
          {title}
        </h1>
        {children}
      </section>
    </div>
  );
}

/**
 * Signed out: sign in as the invited address, by Google or a link emailed to it, and come straight back
 * here, where joining happens by itself.
 */
function SignInToJoin({
  invite,
  error,
  onError,
  linkSentTo,
  onLinkSent,
}: {
  invite: Invite;
  error: string | null;
  onError: (message: string | null) => void;
  linkSentTo: string | null;
  onLinkSent: (email: string) => void;
}) {
  const [busy, setBusy] = useState<'google' | 'email' | null>(null);
  const run = async (kind: 'google' | 'email') => {
    setBusy(kind);
    onError(null);
    try {
      if (kind === 'google') {
        await signInWithGoogle(window.location.href);
      } else {
        await requestEmailSignInLink(invite.email, window.location.href);
        onLinkSent(invite.email);
      }
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : 'Unable to sign in.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <JoinCard title={`Join ${invite.orgName} on CloudChef`}>
      <p className="app-page-lede break-words">
        {invite.inviterName} invited <span className="break-all">{invite.email}</span>. Sign in as that address to join;
        you&apos;ll come straight back here.
      </p>
      {error ? (
        <p className="mt-4 text-sm text-content-error" role="alert">
          {error}
        </p>
      ) : null}
      {linkSentTo ? (
        <p className="mt-4 break-words text-sm text-content-secondary" role="status">
          Check <span className="break-all">{linkSentTo}</span> for a sign-in link, and open it in this browser.
        </p>
      ) : (
        <>
          <p className="mt-4 break-words text-sm text-content-secondary">
            Continue with Google, or get a sign-in link at <span className="break-all">{invite.email}</span> and open it
            in this browser.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button loading={busy === 'google'} disabled={busy !== null} onClick={() => void run('google')}>
              Continue with Google
            </Button>
            <Button
              variant="neutral"
              loading={busy === 'email'}
              disabled={busy !== null}
              onClick={() => void run('email')}
            >
              Email me a sign-in link
            </Button>
          </div>
        </>
      )}
    </JoinCard>
  );
}
