import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Modal } from '~/components/ui/primitives/Modal';
import { Button, buttonClassNames } from '~/components/ui/primitives/Button';
import { authClient, createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';

/**
 * A grant status of `unknown` means the connection predates provider-confirmed OAuth scopes
 * (migration 0016), so CloudChef cannot tell which Cloudflare permissions it actually holds and
 * every scope-gated feature stays disabled. This interstitial makes the reconnect unavoidable on
 * a workspace without breaking it: the owner can reauthorize now or defer with "Later", and
 * builds keep working either way. Deferral is remembered for the browser session so it does not
 * reappear on every render.
 */
const DEFERRED_STORAGE_KEY = 'cloudchef:cloudflare-reauthorize-deferred';

const connectionSchema = z.looseObject({
  oauthScopeGrantStatus: z.enum(['unknown', 'core', 'partial', 'full']).nullish(),
});

function deferredThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(DEFERRED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberDeferral(): void {
  try {
    window.sessionStorage.setItem(DEFERRED_STORAGE_KEY, '1');
  } catch {
    // A private window or blocked storage just means the prompt can reappear next render;
    // that is a weaker deferral, never a broken one.
  }
}

export function ReauthorizeInterstitial() {
  const { data: session } = authClient.useSession();
  // In an organization's account the connection is the organization's: only its admins reconnect it, from
  // its settings. Reconnecting here would reach for the person's own Cloudflare login instead.
  const organization = session?.context?.kind === 'organization' ? session.context : null;
  const [needsReauthorization, setNeedsReauthorization] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (deferredThisSession()) {
      return undefined;
    }
    let canceled = false;
    void fetch('/api/cloudflare/connection')
      .then(async (response) => (response.ok ? connectionSchema.safeParse(await response.json()) : null))
      .then((parsed) => {
        if (!canceled && parsed?.success && parsed.data.oauthScopeGrantStatus === 'unknown') {
          setNeedsReauthorization(true);
        }
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, []);

  if (!needsReauthorization) {
    return null;
  }

  const defer = () => {
    rememberDeferral();
    setNeedsReauthorization(false);
  };

  const reconnect = async () => {
    setReconnecting(true);
    try {
      await signInWithCloudflare(createCloudflareReturnURL(window.location.href));
    } catch {
      setReconnecting(false);
    }
  };

  if (organization) {
    const admin = organization.role === 'admin';
    return (
      <Modal title="Reauthorize Cloudflare" onClose={defer}>
        <p className="text-sm text-content-secondary">
          {organization.orgName}&apos;s Cloudflare connection was made before CloudChef recorded which permissions it
          holds.{' '}
          {admin
            ? 'Reconnect its Cloudflare account from Settings to enable the full agent.'
            : 'Ask one of its admins to reconnect its Cloudflare account to enable the full agent.'}{' '}
          Existing projects and builds keep working in the meantime.
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="neutral" size="sm" onClick={defer}>
            Later
          </Button>
          {admin ? (
            <a className={buttonClassNames({ variant: 'primary', size: 'sm' })} href="/settings#organizations">
              Open organization settings
            </a>
          ) : null}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Reauthorize Cloudflare" onClose={defer}>
      <p className="text-sm text-content-secondary">
        This Cloudflare connection was made before CloudChef recorded which permissions it holds. Reauthorize to confirm
        your permissions and enable the full agent. Your existing projects and builds keep working in the meantime.
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="neutral" size="sm" onClick={defer}>
          Later
        </Button>
        <Button variant="primary" size="sm" loading={reconnecting} onClick={() => void reconnect()}>
          Reauthorize Cloudflare
        </Button>
      </div>
    </Modal>
  );
}
