import { useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@ui/Button';
import { BrandLink } from '~/components/BrandLink';
import { SessionCheckError } from '~/components/SignInPrompt';
import { Loading } from '~/components/Loading';
import { ConnectCloudflareButton } from '~/components/showcase/ConnectCloudflareButton';
import { authClient, signOutOfCloudChef } from '~/lib/auth-client';
import { useGoogleOrEmailSignIn } from '~/lib/hooks/useGoogleOrEmailSignIn';
import { createPrivatePageHead } from '~/lib/social-meta';
import { messageOf, postJson, RequestError } from '~/lib/json-request';

const searchSchema = z.object({ token: z.string().optional().catch(undefined) });
const invitationSchema = z.object({
  projectName: z.string(),
  inviterName: z.string(),
  email: z.string(),
  role: z.enum(['view', 'edit']),
});
type Invitation = z.infer<typeof invitationSchema>;
const acceptedSchema = z.object({ projectId: z.string(), needsCloudflare: z.boolean() });

/**
 * Where a project's emailed invitation lands. Signing in with the address it was sent to (Google, or an emailed link)
 * takes it at once; the project is then in "Shared with you" on the projects home. Working on it needs a Cloudflare
 * account of the person's own, which the page offers to connect when they have none.
 */
export const Route = createFileRoute('/shared')({
  validateSearch: searchSchema,
  head: () => createPrivatePageHead('A project shared with you | CloudChef', 'Open a project someone shared with you.'),
  component: Shared,
});

function Shared() {
  const { token } = Route.useSearch();
  const { data: session, isPending, error: sessionError } = authClient.useSession();
  const [invitation, setInvitation] = useState<Invitation | 'invalid' | null>(token ? null : 'invalid');
  const [error, setError] = useState<string | null>(null);
  const [needsProof, setNeedsProof] = useState(false);
  const [accepted, setAccepted] = useState<z.infer<typeof acceptedSchema> | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
  const started = useRef(false);
  const signIn = useGoogleOrEmailSignIn({
    onError: setError,
    onLinkSent: setLinkSentTo,
    failure: 'Unable to sign in.',
  });

  useEffect(() => {
    if (token) {
      void postJson('/api/project-invitations/describe', { token }, invitationSchema).then(setInvitation, () =>
        setInvitation('invalid'),
      );
    }
  }, [token]);

  const accept = async () => {
    if (!token) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const answer = await postJson('/api/project-invitations/accept', { token }, acceptedSchema);
      if (!answer.needsCloudflare) {
        window.location.assign('/');
        return;
      }
      setAccepted(answer);
    } catch (refusal) {
      setNeedsProof(refusal instanceof RequestError && refusal.code === 'email_unproven');
      setError(messageOf(refusal, 'This invitation could not be opened.'));
    }
    setBusy(false);
  };

  const invited = invitation !== null && invitation !== 'invalid' ? invitation : null;
  const signedInAsInvited = session !== null && invited?.email.toLowerCase() === session.user.email.toLowerCase();
  useEffect(() => {
    if (signedInAsInvited && !started.current) {
      started.current = true;
      void accept();
    }
    // `accept` reads only the token and stable setters.
  }, [signedInAsInvited]); // oxlint-disable-line react/exhaustive-deps

  if (!isPending && !session && sessionError) {
    return (
      <SharedCard title="A project shared with you">
        <SessionCheckError className="mt-4" />
      </SharedCard>
    );
  }
  if (isPending || invitation === null) {
    return <Loading message="Opening your invitation…" />;
  }
  if (!invited) {
    return (
      <SharedCard title="This invitation can’t be used">
        <p className="app-page-lede">
          It has been used, cancelled or has expired. Ask the person who shared the project to send it again.
        </p>
      </SharedCard>
    );
  }
  const can =
    invited.role === 'edit'
      ? 'You can change it and put your changes live on their site.'
      : 'You can look through it, see its history and download it.';
  const title = `${invited.inviterName} shared ${invited.projectName} with you`;
  if (accepted) {
    return (
      <SharedCard title={title}>
        <p className="app-page-lede wrap-break-word">
          It’s in your projects now. {can} To work on it, connect a Cloudflare account of your own: your workspace runs
          there, and {invited.inviterName}’s site stays in theirs.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <ConnectCloudflareButton />
        </div>
      </SharedCard>
    );
  }
  if (!session) {
    return (
      <SharedCard title={title}>
        <p className="app-page-lede wrap-break-word">
          {can} Sign in as <span className="break-all">{invited.email}</span> to open it, with Google or a link we email
          you. You’ll come straight back here.
        </p>
        <ErrorLine error={error} />
        {linkSentTo ? (
          <p className="mt-4 wrap-break-word text-sm text-content-secondary" role="status">
            We sent a sign-in link to <span className="break-all">{linkSentTo}</span>. Open it in this browser.
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              loading={signIn.busy === 'google'}
              disabled={signIn.busy !== null}
              onClick={() => void signIn.continueWithGoogle()}
            >
              Continue with Google
            </Button>
            <Button
              variant="neutral"
              loading={signIn.busy === 'email'}
              disabled={signIn.busy !== null}
              onClick={() => void signIn.emailLink(invited.email)}
            >
              Email me a sign-in link
            </Button>
          </div>
        )}
      </SharedCard>
    );
  }
  return (
    <SharedCard title={title}>
      <p className="app-page-lede wrap-break-word">
        {can} You’re signed in as <span className="break-all">{session.user.email}</span>.
      </p>
      {signedInAsInvited ? null : (
        <p className="mt-2 wrap-break-word text-sm text-content-secondary">
          This invitation is for <span className="break-all">{invited.email}</span>. Sign in with that address to open
          it.
        </p>
      )}
      <ErrorLine error={error} />
      {needsProof && !linkSentTo ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="neutral"
            loading={signIn.busy === 'email'}
            disabled={signIn.busy !== null}
            onClick={() => void signIn.emailLink(session.user.email)}
          >
            Confirm my email
          </Button>
        </div>
      ) : null}
      {linkSentTo ? (
        <p className="mt-4 wrap-break-word text-sm text-content-secondary" role="status">
          Open the link sent to <span className="break-all">{linkSentTo}</span> in this browser.
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {signedInAsInvited ? (
          <Button loading={busy} onClick={() => void accept()}>
            Open it
          </Button>
        ) : null}
        <Button variant="neutral" onClick={() => void signOutOfCloudChef(window.location.href)}>
          Use another account
        </Button>
      </div>
    </SharedCard>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className="mt-4 text-sm text-content-error" role="alert">
      {error}
    </p>
  ) : null;
}

function SharedCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <section className="app-error-card app-card m-auto shrink-0" aria-labelledby="shared-heading">
        <BrandLink />
        <h1 id="shared-heading" className="app-page-title mt-4 text-2xl! wrap-break-word">
          {title}
        </h1>
        {children}
      </section>
    </div>
  );
}
