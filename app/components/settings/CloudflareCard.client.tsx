import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import { createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';
import { z } from 'zod';

const connectionStatusSchema = z.looseObject({
  accountName: z.string().nullish(),
  oauthScopeGrantStatus: z.enum(['unknown', 'core', 'partial', 'full']).nullish(),
});

const GRANT_STATUS_SENTENCES = {
  // A legacy or unverifiable grant: the recorded permissions predate provider-confirmed scopes.
  unknown: 'Reauthorize to record which Cloudflare permissions this connection holds.',
  core: 'Core build permissions granted.',
  partial: 'Partial Cloudflare permissions granted. Reauthorize to grant full access.',
  full: 'Full Cloudflare permissions granted.',
} as const;

type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export function CloudflareCard({ initialError = null }: { initialError?: string | null }) {
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  useEffect(() => {
    let canceled = false;
    void fetch('/api/cloudflare/connection')
      .then(async (response) => {
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
      setError(connectionError instanceof Error ? connectionError.message : 'Unable to connect Cloudflare.');
      setConnecting(false);
    }
  };

  return (
    <section id="cloudflare" className="app-card w-full p-4" aria-labelledby="cloudflare-heading">
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
              {connection.oauthScopeGrantStatus ? ` ${GRANT_STATUS_SENTENCES[connection.oauthScopeGrantStatus]}` : ''}
            </p>
          ) : (
            <p className="mt-1 max-w-2xl text-sm text-content-secondary">
              Connect Cloudflare to build and deploy. Cloudflare bills this account directly.
            </p>
          )}
        </div>
        {!loading ? (
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
      {error ? (
        <p className="mt-3 text-sm text-bolt-elements-icon-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-content-tertiary">Requires Cloudflare Workers Paid and Containers.</p>
    </section>
  );
}
