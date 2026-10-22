import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import {
  authClient,
  createCloudflareReturnURL,
  ReauthenticationRequiredError,
  signInWithCloudflare,
} from '~/lib/auth-client';
import { z } from 'zod';
import { ReauthenticateButtons } from './ReauthenticateButtons';

const connectionStatusSchema = z.looseObject({
  accountName: z.string().nullish(),
  oauthScopeGrantStatus: z.enum(['core', 'partial', 'full']).nullish(),
});

const GRANT_STATUS_SENTENCES = {
  core: 'Core build permissions granted.',
  partial: 'Partial Cloudflare permissions granted. Reauthorize to grant full access.',
  full: 'Full Cloudflare permissions granted.',
} as const;

type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export function CloudflareCard({ initialError = null }: { initialError?: string | null }) {
  const { data: session } = authClient.useSession();
  // In an organization's account, its admins connect and reauthorize it (in Organizations below).
  const organization = session?.context?.kind === 'organization' ? session.context : null;
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  // Attaching a Cloudflare login to a Google or emailed-link account asks for a recent sign-in first.
  const [reauthenticateReason, setReauthenticateReason] = useState<string | null>(null);
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
  const admin = organization?.role === 'admin';
  // An organization member can't change its connection; they may connect an account of their own.
  const offersOwnAccount = organization !== null && !session?.contexts.some((option) => option.kind === 'personal');

  useEffect(() => {
    let canceled = false;
    void fetch('/api/cloudflare/connection')
      .then(async (response) => {
        // Signed in without an account to build in yet: nothing connected, which isn't an error.
        if (response.status === 401) {
          return null;
        }
        if (!response.ok) {
          throw new Error('Unable to load Cloudflare connection status.');
        }
        const status = connectionStatusSchema.safeParse(await response.json());
        if (!status.success) {
          throw new Error('Unable to load Cloudflare connection status.');
        }
        return status.data;
      })
      .then((status) => {
        if (!canceled) {
          setConnection(status);
        }
      })
      .catch((statusError) => {
        if (!canceled) {
          setError(statusError instanceof Error ? statusError.message : 'Unable to load Cloudflare.');
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, []);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await signInWithCloudflare(createCloudflareReturnURL(window.location.href));
    } catch (connectionError) {
      if (connectionError instanceof ReauthenticationRequiredError) {
        setReauthenticateReason(connectionError.message);
      } else {
        setError(connectionError instanceof Error ? connectionError.message : 'Unable to connect Cloudflare.');
      }
      setConnecting(false);
    }
  };

  return (
    <section
      id="cloudflare"
      className="app-card w-full min-w-0 p-4 [overflow-wrap:anywhere]"
      aria-labelledby="cloudflare-heading"
    >
      <div className="flex flex-col items-start gap-3">
        <div className="min-w-0 w-full break-words">
          <h2 id="cloudflare-heading" className="app-card-title">
            Cloudflare account
          </h2>
          {loading ? (
            <p className="mt-1 text-sm text-content-secondary" role="status">
              Checking connection…
            </p>
          ) : connection ? (
            <p className="mt-1 text-sm text-content-secondary">
              Connected{connection.accountName ? ` to ${connection.accountName}` : ''}.
              {/* What to reauthorize is for whoever can: the account's owner, or an organization's admins. */}
              {connection.oauthScopeGrantStatus && (!organization || admin)
                ? ` ${GRANT_STATUS_SENTENCES[connection.oauthScopeGrantStatus]}`
                : ''}
            </p>
          ) : organization ? null : (
            <p className="mt-1 max-w-2xl text-sm text-content-secondary">
              Connect Cloudflare to build and deploy. Cloudflare bills this account directly.
            </p>
          )}
        </div>
        {organization ? (
          <>
            <p className="text-sm text-content-secondary">
              This Cloudflare account belongs to the team {organization.orgName}; its admins manage the connection
              {admin ? ' (as one, you reconnect it under Teams).' : '.'}
            </p>
            {offersOwnAccount ? (
              <Button size="sm" variant="neutral" loading={connecting} onClick={() => void connect()}>
                Connect your own Cloudflare account
              </Button>
            ) : null}
          </>
        ) : !loading ? (
          <Button
            size="sm"
            variant={connection ? 'neutral' : 'primary'}
            loading={connecting}
            onClick={() => void connect()}
          >
            {connection ? 'Reauthorize Cloudflare' : 'Connect Cloudflare'}
          </Button>
        ) : null}
      </div>
      {reauthenticateReason ? (
        <div role="status" className="mt-3 text-sm text-content-secondary">
          <p>
            {linkSentTo
              ? `Open the link sent to ${linkSentTo}, then come back here and connect Cloudflare again.`
              : reauthenticateReason}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <ReauthenticateButtons onError={setError} onLinkSent={setLinkSentTo} />
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="mt-3 text-sm text-bolt-elements-icon-error" role="alert">
          {error}
        </p>
      ) : null}
      {organization && !admin && !offersOwnAccount ? null : (
        <p className="mt-3 text-xs text-content-tertiary">Requires Cloudflare Workers Paid and Containers.</p>
      )}
    </section>
  );
}
