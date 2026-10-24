import { useEffect, useState } from 'react';
import { Button, buttonClassNames } from '~/components/ui/primitives/Button';
import {
  authClient,
  createCloudflareReturnURL,
  ReauthenticationRequiredError,
  signInWithCloudflare,
} from '~/lib/auth-client';
import { z } from 'zod';
import { getJson, messageOf, RequestError } from '~/lib/json-request';
import { ReauthenticatePrompt } from './ReauthenticatePrompt';
import { errorFeedback, FeedbackLine } from './Feedback';
import { SettingsCard, StatusBadge } from './SettingsLayout';

const connectionStatusSchema = z.looseObject({
  accountName: z.string().nullish(),
});

type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/** The Cloudflare account this session builds in, whether it is connected, and connecting it. */
export function CloudflareCard({ initialError = null }: { initialError?: string | null }) {
  const { data: session } = authClient.useSession();
  // In a team's account, its admins connect and reauthorize it (under Teams).
  const organization = session?.context?.kind === 'organization' ? session.context : null;
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  // Attaching a Cloudflare login to a Google or emailed-link account asks for a recent sign-in first.
  const [reauthenticateReason, setReauthenticateReason] = useState<string | null>(null);
  const admin = organization?.role === 'admin';
  // A team member can't change its connection; they may connect an account of their own.
  const offersOwnAccount = organization !== null && !session?.contexts.some((option) => option.kind === 'personal');

  useEffect(() => {
    let canceled = false;
    void getJson('/api/cloudflare/connection', connectionStatusSchema, 'Unable to load Cloudflare connection status.')
      .then((status) => {
        if (!canceled) {
          setConnection(status);
        }
      })
      .catch((statusError) => {
        // Signed in without an account to build in yet: nothing connected, which isn't an error.
        if (!canceled && !(statusError instanceof RequestError && statusError.status === 401)) {
          setError(messageOf(statusError, 'Unable to load Cloudflare.'));
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
        setError(messageOf(connectionError, 'Unable to connect Cloudflare.'));
      }
      setConnecting(false);
    }
  };

  const accountName = connection?.accountName ?? organization?.accountName ?? null;

  const action = organization ? (
    admin ? (
      <a href="#teams" className={buttonClassNames({ variant: 'neutral', size: 'sm' })}>
        Manage in Teams
      </a>
    ) : offersOwnAccount ? (
      <Button size="sm" variant="neutral" loading={connecting} onClick={() => void connect()}>
        Connect your own account
      </Button>
    ) : null
  ) : loading ? null : (
    <Button size="sm" variant={connection ? 'neutral' : 'primary'} loading={connecting} onClick={() => void connect()}>
      {connection ? 'Reauthorize Cloudflare' : 'Connect Cloudflare'}
    </Button>
  );

  return (
    <SettingsCard
      id="cloudflare"
      title="Cloudflare account"
      description="Where your projects build and run. Cloudflare bills this account."
      action={action}
    >
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-bolt-elements-borderColor px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm text-content-primary" title={accountName ?? undefined}>
          {loading ? 'Checking…' : connection || organization ? (accountName ?? 'Cloudflare account') : 'None yet'}
        </span>
        {loading ? null : connection ? (
          <StatusBadge tone="success">{organization ? `Managed by ${organization.orgName}` : 'Connected'}</StatusBadge>
        ) : organization ? (
          <StatusBadge>Managed by {organization.orgName}</StatusBadge>
        ) : (
          <StatusBadge tone="warning">Not connected</StatusBadge>
        )}
      </div>
      {reauthenticateReason ? (
        <ReauthenticatePrompt
          className="mt-3 text-sm text-content-secondary"
          reason={reauthenticateReason}
          next="come back here and connect Cloudflare again"
          onError={setError}
        />
      ) : null}
      <FeedbackLine feedback={errorFeedback(error)} className="mt-3" />
      {organization && !admin && !offersOwnAccount ? null : (
        <p className="mt-2 text-xs text-content-tertiary">Needs Workers Paid and Containers.</p>
      )}
    </SettingsCard>
  );
}
