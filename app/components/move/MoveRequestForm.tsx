import { useEffect, useId, useState, type FormEvent } from 'react';
import { SignInOverlay } from '~/components/showcase/SignInOverlay';
import { Button } from '~/components/ui/primitives/Button';
import { TextInput } from '~/components/ui/primitives/TextInput';
import { authClient } from '~/lib/auth-client';
import { getJson, messageOf, postJson } from '~/lib/json-request';
import {
  MOVE_NOTE_MAX_LENGTH,
  MOVE_PLATFORMS,
  MOVE_SITE_URL_MAX_LENGTH,
  moveRequestsSchema,
  normalizeMoveSiteUrl,
  type MovePlatform,
  type MoveRequest,
} from '~/lib/move-requests';

const PLATFORM_LABELS = {
  shopify: 'Shopify',
  wordpress: 'WordPress',
  other: 'Something else',
} satisfies Record<MovePlatform, string>;

/**
 * Asking for a site to be moved, at the foot of `/move`: for someone signed in, the form and the requests they
 * already made, each with a way to withdraw it; for anyone else, the usual sign-in over the page, which returns to
 * `returnTo` (this section). `platform` is what the page they opened is about, chosen for them to start with.
 */
export function MoveRequestForm({ platform, returnTo }: { platform: MovePlatform; returnTo: string }) {
  const { data: session, isPending } = authClient.useSession();
  const [signingIn, setSigningIn] = useState(false);

  if (isPending) {
    return (
      <p className="text-sm text-content-secondary" role="status">
        Checking whether you’re signed in…
      </p>
    );
  }
  if (!session) {
    return (
      <div className="grid justify-items-start gap-3">
        <p className="text-sm text-content-secondary">
          Sign in first, so the request is yours to change or withdraw and we know where to write to you.
        </p>
        <Button size="lg" onClick={() => setSigningIn(true)}>
          Sign in to request a move
        </Button>
        {signingIn ? (
          <SignInOverlay title="Sign in to request a move" returnTo={returnTo} onClose={() => setSigningIn(false)} />
        ) : null}
      </div>
    );
  }
  return <SignedInMoveRequests platform={platform} email={session.user.email} />;
}

function SignedInMoveRequests({ platform: initialPlatform, email }: { platform: MovePlatform; email: string }) {
  const id = useId();
  const [siteUrl, setSiteUrl] = useState('');
  const [platform, setPlatform] = useState<MovePlatform>(initialPlatform);
  const [note, setNote] = useState('');
  const [requests, setRequests] = useState<MoveRequest[]>([]);
  const [saving, setSaving] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    void getJson('/api/move-requests', moveRequestsSchema)
      .then((answer) => {
        if (!canceled) {
          setRequests(answer.requests);
        }
      })
      .catch(() => {
        // Not knowing only leaves the list empty; sending the form answers with the whole list.
      });
    return () => {
      canceled = true;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSent(null);
    const address = normalizeMoveSiteUrl(siteUrl);
    if (!address) {
      setError('Enter your site’s address as it appears in a browser, such as https://example.com.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const answer = await postJson(
        '/api/move-requests/save',
        { siteUrl: address, platform, note },
        moveRequestsSchema,
        'Unable to send your request. Try again.',
      );
      setRequests(answer.requests);
      setSent(address);
      setSiteUrl('');
      setNote('');
    } catch (failure) {
      setError(messageOf(failure, 'Unable to send your request. Try again.'));
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async (address: string) => {
    setWithdrawing(address);
    setError(null);
    setSent(null);
    try {
      const answer = await postJson(
        '/api/move-requests/withdraw',
        { siteUrl: address },
        moveRequestsSchema,
        'Unable to withdraw that request. Try again.',
      );
      setRequests(answer.requests);
    } catch (failure) {
      setError(messageOf(failure, 'Unable to withdraw that request. Try again.'));
    } finally {
      setWithdrawing(null);
    }
  };

  return (
    <>
      <form className="move-page__form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="move-page__field">
          <label className="move-page__label" htmlFor={`${id}-site`}>
            Your site’s address
          </label>
          <TextInput
            id={`${id}-site`}
            name="siteUrl"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://your-site.com"
            required
            maxLength={MOVE_SITE_URL_MAX_LENGTH}
            value={siteUrl}
            onChange={(event) => setSiteUrl(event.target.value)}
            className="min-h-11 w-full"
          />
        </div>
        <fieldset className="move-page__field">
          <legend className="move-page__label">What it runs on</legend>
          <div className="move-page__choices mt-1.5">
            {MOVE_PLATFORMS.map((value) => (
              <label key={value} className="move-page__choice">
                <input
                  type="radio"
                  name="platform"
                  value={value}
                  checked={platform === value}
                  onChange={() => setPlatform(value)}
                />
                {PLATFORM_LABELS[value]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="move-page__field">
          <label className="move-page__label" htmlFor={`${id}-note`}>
            Anything we should know <span className="font-normal text-content-tertiary">(optional)</span>
          </label>
          <textarea
            id={`${id}-note`}
            name="note"
            className="move-page__note"
            maxLength={MOVE_NOTE_MAX_LENGTH}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <p className="move-page__hint">
            We’ll write to <span className="break-all">{email}</span>. Leave out passwords and anything private.
          </p>
        </div>
        {error ? (
          <p className="text-sm text-content-error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" size="lg" loading={saving} disabled={saving}>
            Request a move
          </Button>
        </div>
        {sent ? (
          <p className="text-sm text-content-success" role="status">
            Request sent for <span className="break-all">{sent}</span>.
          </p>
        ) : null}
      </form>
      {requests.length > 0 ? (
        <div className="move-page__requests">
          <h3>Your {requests.length === 1 ? 'request' : 'requests'}</h3>
          <ul className="grid gap-2">
            {requests.map((request) => (
              <li key={request.siteUrl} className="move-page__request-row">
                <div className="min-w-0">
                  <strong className="font-semibold">{request.siteUrl}</strong>
                  <p>
                    {PLATFORM_LABELS[request.platform]} · asked{' '}
                    <time dateTime={request.createdAt}>
                      {new Date(request.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                    </time>
                  </p>
                  {request.note ? <p className="mt-1 whitespace-pre-wrap">{request.note}</p> : null}
                </div>
                <Button
                  variant="neutral"
                  size="sm"
                  loading={withdrawing === request.siteUrl}
                  disabled={withdrawing !== null}
                  onClick={() => void withdraw(request.siteUrl)}
                >
                  Withdraw
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
