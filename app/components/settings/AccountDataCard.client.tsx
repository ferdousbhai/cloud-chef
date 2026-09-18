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

  const reauthenticate = async () => {
    setError(null);
    try {
      await signInWithCloudflare(createCloudflareReturnURL(window.location.href));
    } catch (authorizationError) {
      setError(authorizationError instanceof Error ? authorizationError.message : 'Unable to reconnect Cloudflare.');
    }
  };

  return (
    <section id="your-data" className="app-card w-full p-4" aria-labelledby="account-data-heading">
      <h2 id="account-data-heading" className="app-card-title">
        Your data
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-content-secondary">
        CloudChef’s own database holds your Cloudflare identity and email, your sign-in sessions, your encrypted
        Cloudflare credentials and granted scopes, and the address of your workspace runtime. Your chats, project files,
        deployment records, and every Worker, D1 database, R2 bucket, KV namespace, Container, Durable Object, and Agent
        CloudChef created live in your own Cloudflare account, not here. See the{' '}
        <Link to="/privacy">Privacy notice</Link> for the full inventory.
      </p>

      <h3 className="mt-3 text-sm font-medium text-content-primary">Download your project source</h3>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        Open a project and choose <strong>Download code</strong> in the project header to save a ZIP of its files. Local
        secret files are excluded. This is per project, so download each project you want to keep. Chats, deployment
        history, and generated infrastructure remain readable in your Cloudflare account.
      </p>

      <h3 className="mt-3 text-sm font-medium text-content-primary">Download your account data</h3>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        Save a JSON file of everything CloudChef’s own database holds for your account: your identity and email, your
        Cloudflare connection metadata and granted scopes, the fact that an encrypted credential exists and when it was
        stored, your workspace runtime address, and your sign-in and authorization session records. Encrypted
        credentials, their initialisation vectors, credential handles, and session tokens are never included.
      </p>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        It does <strong>not</strong> contain your chats, transcripts, project files, or deployment records. Those live
        in your own Cloudflare account, not in CloudChef’s database — use <strong>Download code</strong> above for
        project source and your Cloudflare account’s own tools for the rest. CloudChef asks you to reconnect Cloudflare
        first, because the file is a complete copy of your account record.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="neutral"
          loading={exportPhase === 'downloading'}
          disabled={exportPhase === 'downloading'}
          onClick={() => void downloadAccountData()}
        >
          Download my account data
        </Button>
        {exportPhase === 'reauthenticate' ? (
          <Button size="sm" variant="neutral" onClick={() => void reauthenticate()}>
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

      <h3 className="mt-3 text-sm font-medium text-content-primary">Clear this browser</h3>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        Logging out disposes this browser’s in-memory project cache. To remove everything CloudChef kept on this device,
        clear site data for this site in your browser settings. That removes the <code>cloudchef_session</code> cookie,
        the <code>cloudchef_theme</code> and <code>cloudchef_builder_model</code> preferences, the telemetry preference
        and tab-scoped session state. Repeat this in every browser and profile you have used; no server-side request can
        reach them.
      </p>

      <h3 className="mt-3 text-sm font-medium text-content-primary">Ask for a copy or an erasure</h3>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        For an access, portability, correction, or erasure request that this page does not cover, start on{' '}
        <Link to="/support">Support</Link> with only the request type and your GitHub handle. Do not put account details
        or other private information in the public issue.
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
            This erases your account identity, sign-in sessions, encrypted Cloudflare credentials, connection metadata
            and granted scopes, and your runtime address from CloudChef’s database, and asks Cloudflare to revoke
            CloudChef’s authorization. It cannot be undone.
          </p>
          <p className="mt-2 max-w-2xl text-sm text-content-secondary">
            It does <strong>not</strong> delete anything inside your Cloudflare account. Workers and their unpromoted
            preview versions, production and preview D1 databases, R2 buckets, KV namespaces, Containers, Durable
            Objects, and Agents that CloudChef deployed stay exactly where they are, keep serving traffic, keep costing
            money, and remain yours to remove. It does not clear this browser, and signing in again creates a new, empty
            CloudChef account.
          </p>
          <p className="mt-2 max-w-2xl text-sm text-content-secondary">
            To remove a deployed app, delete its project first and allow its scheduled cleanup to finish — project
            resources are removed no earlier than 30 minutes after deletion. Project deletion removes that project’s
            generated Worker and versions, Durable Objects, D1 databases, KV namespaces, and R2 buckets; it does not
            remove the shared workspace runtime or anything outside that project. Once this account is deleted the
            authorization is gone, so CloudChef can no longer clean up anything on your behalf.
          </p>
          {phase === 'idle' ? (
            <Button className="mt-3" size="sm" variant="danger" onClick={() => setPhase('confirming')}>
              Delete my CloudChef account data
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
                  <Button className="mt-2" size="sm" variant="neutral" onClick={() => void reauthenticate()}>
                    Reconnect Cloudflare
                  </Button>
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
                  <Button size="sm" variant="neutral" disabled={phase === 'deleting'} onClick={() => setPhase('idle')}>
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
