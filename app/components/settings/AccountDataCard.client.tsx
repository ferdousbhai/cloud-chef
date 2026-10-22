import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { ACCOUNT_DELETION_CONFIRMATION, accountExportSectionLabel } from '~/lib/account-data';
import { authClient } from '~/lib/auth-client';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { takeReauthenticationSwitchedAccount } from '~/lib/stores/reauthentication';
import { ReauthenticatePrompt } from './ReauthenticatePrompt';
import { errorFeedback, FeedbackLine } from './Feedback';
import { z } from 'zod';
import { postJson, RequestError } from '~/lib/json-request';

/** What erasing the account reports about what it could not do itself. */
const accountDeletionSchema = z.looseObject({
  cloudflareAuthorizationRevoked: z.boolean().optional().catch(undefined),
  workspacesLeftIn: z.array(z.string()).optional().catch(undefined),
});

const CLOUDFLARE_OAUTH_AUTHORIZATIONS_URL = 'https://dash.cloudflare.com/?to=/profile/access-management/authorization';

type DeletionPhase = 'idle' | 'confirming' | 'deleting' | 'reauthenticate' | 'deleted';
type ExportPhase = 'idle' | 'downloading' | 'reauthenticate' | 'downloaded';

/** The file the account export is saved as. */
const ACCOUNT_EXPORT_FILENAME = 'cloudchef-account-export.json';

export function AccountDataCard() {
  const { data: session } = authClient.useSession();
  const [phase, setPhase] = useState<DeletionPhase>('idle');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [revoked, setRevoked] = useState(false);
  // Known before erasure ends the session: whether there was a Cloudflare grant of their own to revoke.
  const [hadOwnAccount, setHadOwnAccount] = useState(false);
  const [workspacesLeftIn, setWorkspacesLeftIn] = useState<string[]>([]);
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
      const deleted = await postJson(
        '/api/account/delete',
        { confirmation: confirmation.trim(), acknowledgeCloudflareResourcesRetained: acknowledged },
        accountDeletionSchema,
        'Unable to delete.',
      );
      queryClient.clear();
      resetUserRuntimeSession();
      setHadOwnAccount(session?.contexts.some((option) => option.kind === 'personal') ?? false);
      setRevoked(deleted.cloudflareAuthorizationRevoked === true);
      setWorkspacesLeftIn(deleted.workspacesLeftIn ?? []);
      setPhase('deleted');
    } catch (failure) {
      const reauthenticate = failure instanceof RequestError && failure.code === 'reauthentication_required';
      setPhase(reauthenticate ? 'reauthenticate' : 'confirming');
      setError(
        reauthenticate
          ? null
          : failure instanceof RequestError
            ? failure.message
            : 'Unable to reach CloudChef. Check your connection and try again.',
      );
    }
  };

  const cancelDeletion = () => {
    setPhase('idle');
    setConfirmation('');
    setAcknowledged(false);
    setError(null);
  };

  // A fresh sign-in that landed in another account than the one that asked for it: export and
  // erasure would act on that other account, so they wait until the person signs back in.
  const [switchedAccount, setSwitchedAccount] = useState(false);
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (userId && takeReauthenticationSwitchedAccount(userId)) {
      setSwitchedAccount(true);
    }
  }, [userId]);

  return (
    <section
      id="your-data"
      className="app-card w-full min-w-0 p-4 [overflow-wrap:anywhere]"
      aria-labelledby="account-data-heading"
    >
      <h2 id="account-data-heading" className="app-card-title">
        Your data
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-content-secondary">
        Projects and deployed resources live in the Cloudflare account you build in: your own, or your team&apos;s. See
        the <Link to="/privacy">Privacy notice</Link> for what CloudChef itself keeps.
      </p>

      <h3 className="mt-3 text-sm font-medium text-content-primary">Project source</h3>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        Choose <strong>Download code</strong> in each project’s header for a ZIP. Secret files are excluded.
      </p>

      <h3 className="mt-3 text-sm font-medium text-content-primary">Account data</h3>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        Export your CloudChef account record as JSON. Signing in again may be required.
      </p>
      {switchedAccount && session ? (
        <p className="mt-2 max-w-2xl text-sm text-bolt-elements-icon-error" role="alert">
          You signed in again as {session.user.email}, a different account than the one you started with. Export and
          deletion are off here so they can&apos;t act on the wrong account; sign out and back in as the account you
          meant.
        </p>
      ) : null}
      <details className="mt-2 text-sm text-content-secondary">
        <summary className="cursor-pointer py-1 text-content-primary">What’s included?</summary>
        <p className="mt-1 max-w-2xl">
          Your identity and email and your AI request logs setting; your own Cloudflare connection (its permissions and
          default model) and when its authorization was stored; your workspaces; your teams, the invites sent to you,
          your model use there, and the team projects you were given; your production requests, with a draft&apos;s
          source until it is decided; GitHub connections and approvals you started; emailed sign-in links; and sign-in
          and authorization session records. Credentials, credential handles, encryption vectors, session tokens, and
          the hashes links and invites are checked against are excluded.
        </p>
        <p className="mt-2 max-w-2xl">
          Chats, transcripts, project files, and deployment records are not included. They live in the Cloudflare
          account you build in. Use <strong>Download code</strong> for project source and Cloudflare’s tools for the
          rest.
        </p>
      </details>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="neutral"
          loading={exportPhase === 'downloading'}
          disabled={exportPhase === 'downloading' || switchedAccount}
          onClick={() => void downloadAccountData()}
        >
          Download account data
        </Button>
      </div>
      {exportPhase === 'reauthenticate' ? (
        <ReauthenticatePrompt
          className="mt-2 max-w-2xl text-sm text-content-secondary"
          reason="Sign in again to confirm it is you, then download again."
          next="download again"
          onError={setExportError}
        />
      ) : null}
      {unavailableSections.length > 0 ? (
        <p className="mt-2 max-w-2xl text-sm text-bolt-elements-icon-error" role="alert">
          CloudChef could not read {unavailableSections.map(accountExportSectionLabel).join(', ')}, so{' '}
          <code>{ACCOUNT_EXPORT_FILENAME}</code> is not a complete copy and says so inside. Try again, and if it keeps
          failing use the request path below.
        </p>
      ) : exportPhase === 'downloaded' ? (
        <p className="mt-2 max-w-2xl text-sm text-content-secondary" role="status">
          Saved <code>{ACCOUNT_EXPORT_FILENAME}</code>.
        </p>
      ) : null}
      <FeedbackLine feedback={errorFeedback(exportError)} className="mt-2 max-w-2xl" />

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
            CloudChef erased your account identity, sessions, encrypted credentials, connection metadata, team
            memberships, and workspace addresses from its own database.
          </p>
          {workspacesLeftIn.length > 0 ? (
            <p className="mt-2 text-bolt-elements-icon-error">
              Your workspace couldn&apos;t be deleted from the Cloudflare account of {workspacesLeftIn.join(', ')}; ask
              its admins to remove it there.
            </p>
          ) : null}
          <p className="mt-2">
            {!hadOwnAccount ? null : revoked ? (
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
            Resources CloudChef deployed are still in the Cloudflare accounts they were deployed to, and still billed to
            them. Clear this browser’s site data to remove its cookie, preferences, and tab-session state.
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
            To remove apps you deployed to your own Cloudflare account, delete their projects first and wait for cleanup
            (at least 30 minutes). This removes each project’s resources, but not your workspace runtime there or
            unrelated resources. After account deletion, CloudChef can no longer clean up resources for you.
          </p>
          <p className="mt-2 max-w-2xl text-sm text-content-secondary">
            In a team, you leave it, and your workspace in its Cloudflare account (your chats and project files there)
            is deleted. Apps you deployed there stay, for its admins to keep or remove. If you&apos;re a team&apos;s
            only admin, make someone else an admin first.
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
                  I understand this is irreversible, and that apps and resources deployed to Cloudflare are retained: in
                  my own account they remain my responsibility, and in a team&apos;s account its admins&apos;.
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
                <ReauthenticatePrompt
                  className="text-sm text-content-secondary"
                  reason="Sign in again to confirm it is you, then return here and delete again."
                  next="return here and delete again"
                  onError={setError}
                >
                  {/* Signed in again elsewhere (an emailed link opened in another tab): delete from here. */}
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={!confirmed || switchedAccount}
                    onClick={() => void requestDeletion()}
                  >
                    Permanently delete
                  </Button>
                  <Button size="sm" variant="neutral" onClick={cancelDeletion}>
                    Cancel
                  </Button>
                </ReauthenticatePrompt>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={phase === 'deleting'}
                    disabled={!confirmed || phase === 'deleting' || switchedAccount}
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
      <FeedbackLine feedback={errorFeedback(error)} className="mt-3" />
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
