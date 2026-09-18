import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { ACCOUNT_DELETION_CONFIRMATION } from '~/lib/account-data';
import { createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';
import { disposeClientCollections } from '~/lib/cloudflare/client-collections';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { z } from 'zod';

/** Failure envelopes returned by the account deletion and export endpoints. */
const accountDeletionPayloadSchema = z.looseObject({
  code: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  cloudflareAuthorizationRevoked: z.boolean().optional().catch(undefined),
});

const CLOUDFLARE_OAUTH_AUTHORIZATIONS_URL = 'https://dash.cloudflare.com/?to=/profile/access-management/authorization';

type DeletionPhase = 'idle' | 'confirming' | 'deleting' | 'reauthenticate' | 'deleted';
type ExportPhase = 'idle' | 'downloading' | 'reauthenticate' | 'downloaded';

/** The file the account export is saved as. */
const ACCOUNT_EXPORT_FILENAME = 'cloudchef-account-export.json';

export function AccountDataCard() {
  const [phase, setPhase] = useState<DeletionPhase>('idle');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportPhase, setExportPhase] = useState<ExportPhase>('idle');
  const [exportError, setExportError] = useState<string | null>(null);
  const [unavailableSections, setUnavailableSections] = useState<string[]>([]);
  const confirmed = confirmation.trim() === ACCOUNT_DELETION_CONFIRMATION && acknowledged;

  const downloadAccountData = async () => {
    setExportPhase('downloading');
    setExportError(null);
    setUnavailableSections([]);
    try {
      const response = await fetch('/api/account/export', { method: 'POST', credentials: 'same-origin' });
      // The saved file is the server's own bytes rather than a re-serialization, so
      // what the user keeps is exactly what CloudChef said it held.
      const exportDocument = await response.text();
      const payload = parseExportPayload(exportDocument);
      if (!response.ok) {
        setExportPhase(payload?.code === 'reauthentication_required' ? 'reauthenticate' : 'idle');
        setExportError(
          payload?.code === 'reauthentication_required' ? null : (payload?.error ?? 'Unable to export your data.'),
        );
        return;
      }
      const { default: fileSaver } = await import('file-saver');
      fileSaver.saveAs(new Blob([exportDocument], { type: 'application/json' }), ACCOUNT_EXPORT_FILENAME);
      setUnavailableSections(payload?.unavailableSections ?? []);
      setExportPhase('downloaded');
    } catch {
      setExportPhase('idle');
      setExportError('Unable to reach CloudChef. Check your connection and try again.');
    }
  };

  const requestDeletion = async () => {
    setPhase('deleting');
    setError(null);
    try {
      const response = await fetch('/api/account/delete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: confirmation.trim(),
          acknowledgeCloudflareResourcesRetained: acknowledged,
        }),
      });
      const payload = accountDeletionPayloadSchema.safeParse(await response.json().catch(() => null)).data ?? null;
      if (!response.ok) {
        setPhase(payload?.code === 'reauthentication_required' ? 'reauthenticate' : 'confirming');
        setError(payload?.code === 'reauthentication_required' ? null : (payload?.error ?? 'Unable to delete.'));
        return;
      }
      await disposeClientCollections();
      resetUserRuntimeSession();
      setRevoked(payload?.cloudflareAuthorizationRevoked === true);
      setPhase('deleted');
    } catch {
      setPhase('confirming');
      setError('Unable to reach CloudChef. Check your connection and try again.');
    }
  };

  const cancelDeletion = () => {
    setPhase('idle');
    setConfirmation('');
    setAcknowledged(false);
    setError(null);
  };

  const reauthenticate = async (purpose: 'export' | 'delete') => {
    const reportError = purpose === 'export' ? setExportError : setError;
    reportError(null);
    try {
      await signInWithCloudflare(createCloudflareReturnURL(window.location.href));
    } catch (authorizationError) {
      reportError(authorizationError instanceof Error ? authorizationError.message : 'Unable to reconnect Cloudflare.');
    }
  };

  return (
    <section id="your-data" className="app-card w-full p-4" aria-labelledby="account-data-heading">
      <h2 id="account-data-heading" className="app-card-title">
        Your data
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-content-secondary">
        Projects and deployed resources live in your Cloudflare account. See the{' '}
        <Link to="/privacy">Privacy notice</Link> for details.
      </p>

      <h3 className="mt-3 text-sm font-medium text-content-primary">Project source</h3>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        Choose <strong>Download code</strong> in each project’s header for a ZIP. Secret files are excluded.
      </p>

      <h3 className="mt-3 text-sm font-medium text-content-primary">Account data</h3>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        Export your CloudChef account record as JSON. Reconnecting Cloudflare may be required.
      </p>
      <details className="mt-2 text-sm text-content-secondary">
        <summary className="cursor-pointer py-1 text-content-primary">What’s included?</summary>
        <p className="mt-1 max-w-2xl">
          Your identity and email, connection metadata and granted scopes, credential storage dates, workspace runtime
          address, and sign-in and authorization session records. Credentials, credential handles, encryption vectors,
          and session tokens are excluded.
        </p>
        <p className="mt-2 max-w-2xl">
          Chats, transcripts, project files, and deployment records are not included. They live in your Cloudflare
          account. Use <strong>Download code</strong> for project source and Cloudflare’s tools for the rest.
        </p>
      </details>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="neutral"
          loading={exportPhase === 'downloading'}
          disabled={exportPhase === 'downloading'}
          onClick={() => void downloadAccountData()}
        >
          Download account data
        </Button>
        {exportPhase === 'reauthenticate' ? (
          <Button size="sm" variant="neutral" onClick={() => void reauthenticate('export')}>
            Reconnect Cloudflare
          </Button>
        ) : null}
      </div>
      {exportPhase === 'reauthenticate' ? (
        <p className="mt-2 max-w-2xl text-sm text-content-secondary" role="status">
          Confirm it is you in Cloudflare, then download again.
        </p>
      ) : null}
      {unavailableSections.length > 0 ? (
        <p className="mt-2 max-w-2xl text-sm text-bolt-elements-icon-error" role="alert">
          CloudChef could not read {unavailableSections.join(', ')}, so <code>{ACCOUNT_EXPORT_FILENAME}</code> is not a
          complete copy and says so inside. Try again, and if it keeps failing use the request path below.
        </p>
      ) : exportPhase === 'downloaded' ? (
        <p className="mt-2 max-w-2xl text-sm text-content-secondary" role="status">
          Saved <code>{ACCOUNT_EXPORT_FILENAME}</code>.
        </p>
      ) : null}
      {exportError ? (
        <p className="mt-2 max-w-2xl text-sm text-bolt-elements-icon-error" role="alert">
          {exportError}
        </p>
      ) : null}

      <details className="mt-3 text-sm text-content-secondary">
        <summary className="cursor-pointer py-1 text-content-primary">Clear this browser</summary>
        <p className="mt-1 max-w-2xl">
          Logging out clears the in-memory project cache. Clear this site’s data in your browser settings to remove
          cookies, preferences, and tab-session state. Repeat in each browser and profile you used.
        </p>
      </details>
      <p className="mt-3 max-w-2xl text-sm text-content-secondary">
        For other data requests, contact <Link to="/support">Support</Link> with the request type and your GitHub
        handle. Keep account details and private information out of public issues.
      </p>

      <h3 className="mt-6 text-sm font-medium text-content-primary">Delete your CloudChef account data</h3>
      {phase === 'deleted' ? (
        <div className="mt-2 max-w-2xl text-sm text-content-secondary" role="status">
          <p>
            CloudChef erased your account identity, sessions, encrypted credentials, connection metadata, and runtime
            address from its own database.
          </p>
          <p className="mt-2">
            {revoked ? (
              'Cloudflare confirmed that CloudChef’s authorization was revoked.'
            ) : (
              <>
                Cloudflare did not confirm the revocation. Remove the CloudChef authorization yourself in the Cloudflare
                dashboard under <strong>Profile → Manage OAuth authorizations</strong> (
                <a className="underline" href={CLOUDFLARE_OAUTH_AUTHORIZATIONS_URL}>
                  open OAuth authorizations
                </a>
                ).
              </>
            )}
          </p>
          <p className="mt-2">
            Resources CloudChef deployed are still in your Cloudflare account and still billed to it. Clear this
            browser’s site data to remove its cookie, preferences, and tab-session state.
          </p>
          <p className="mt-3">
            <a className="underline" href="/">
              Return to CloudChef
            </a>
          </p>
        </div>
      ) : (
        <>
          <p className="mt-2 max-w-2xl text-sm text-content-secondary">
            Permanently erases your CloudChef account record, sessions, and stored credentials, and requests revocation
            of CloudChef’s access. Signing in again creates an empty account.
          </p>
          <p className="mt-2 max-w-2xl text-sm text-content-secondary">
            <strong>Your Cloudflare resources remain live and billable.</strong> Browser data is not cleared.
          </p>
          <p className="mt-2 max-w-2xl text-sm text-content-secondary">
            To remove deployed apps, delete their projects first and wait for cleanup (at least 30 minutes). This
            removes each project’s resources, but not the shared workspace runtime or unrelated resources. After account
            deletion, CloudChef can no longer clean up resources for you.
          </p>
          {phase === 'idle' ? (
            <Button className="mt-3" size="sm" variant="danger" onClick={() => setPhase('confirming')}>
              Delete account data
            </Button>
          ) : (
            <div className="mt-3 grid max-w-2xl gap-3">
              <label className="flex items-start gap-2 text-sm text-content-secondary">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  I understand this is irreversible and that my deployed Cloudflare resources are retained and remain my
                  responsibility.
                </span>
              </label>
              <label className="grid gap-1 text-sm text-content-secondary">
                <span>
                  Type <code>{ACCOUNT_DELETION_CONFIRMATION}</code> to confirm.
                </span>
                <TextInput
                  value={confirmation}
                  autoComplete="off"
                  aria-label="Deletion confirmation phrase"
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              {phase === 'reauthenticate' ? (
                <div role="status" className="text-sm text-content-secondary">
                  <p>Confirm it is you in Cloudflare, then return here and delete again.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="neutral" onClick={() => void reauthenticate('delete')}>
                      Reconnect Cloudflare
                    </Button>
                    <Button size="sm" variant="neutral" onClick={cancelDeletion}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={phase === 'deleting'}
                    disabled={!confirmed || phase === 'deleting'}
                    onClick={() => void requestDeletion()}
                  >
                    Permanently delete
                  </Button>
                  <Button size="sm" variant="neutral" disabled={phase === 'deleting'} onClick={cancelDeletion}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {error ? (
        <p className="mt-3 text-sm text-bolt-elements-icon-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const accountExportPayloadSchema = z.looseObject({
  code: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  unavailableSections: z.array(z.string()).optional().catch(undefined),
});

function parseExportPayload(exportDocument: string) {
  try {
    return accountExportPayloadSchema.safeParse(JSON.parse(exportDocument)).data ?? null;
  } catch {
    return null;
  }
}
