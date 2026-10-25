import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { TextInput } from '@ui/TextInput';
import { ACCOUNT_DELETION_CONFIRMATION, accountExportSectionLabel } from '~/lib/account-data';
import { authClient } from '~/lib/auth-client';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { takeReauthenticationSwitchedAccount } from '~/lib/stores/reauthentication';
import { ReauthenticatePrompt } from './ReauthenticatePrompt';
import { errorFeedback, FeedbackLine } from './Feedback';
import { SettingsCard } from './SettingsLayout';
import { z } from 'zod';
import { postJson, RequestError } from '~/lib/json-request';

/** What erasing the account reports about what it could not do itself. */
const accountDeletionSchema = z.looseObject({
  cloudflareAuthorizationRevoked: z.boolean().nullable().optional().catch(undefined),
  cloudflareAuthorizationKeptFor: z.array(z.string()).optional().catch(undefined),
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
  // Whether Cloudflare confirmed every revocation erasure made; null when it made none.
  const [revoked, setRevoked] = useState<boolean | null>(null);
  // Known before erasure ends the session: whether there was a Cloudflare grant of their own to revoke.
  const [hadOwnAccount, setHadOwnAccount] = useState(false);
  const [workspacesLeftIn, setWorkspacesLeftIn] = useState<string[]>([]);
  const [keptFor, setKeptFor] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exportPhase, setExportPhase] = useState<ExportPhase>('idle');
  const [exportError, setExportError] = useState<string | null>(null);
  const [unavailableSections, setUnavailableSections] = useState<string[]>([]);
  const confirmed = confirmation.trim() === ACCOUNT_DELETION_CONFIRMATION && acknowledged;
  // Their own account's authorization stayed, still used by the teams building there.
  const keptOwnAuthorization = hadOwnAccount && keptFor.length > 0;

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
      setRevoked(deleted.cloudflareAuthorizationRevoked ?? null);
      setWorkspacesLeftIn(deleted.workspacesLeftIn ?? []);
      setKeptFor(deleted.cloudflareAuthorizationKeptFor ?? []);
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

  const deletionControls =
    phase === 'reauthenticate' ? (
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
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="neutral" disabled={phase === 'deleting'} onClick={cancelDeletion}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={phase === 'deleting'}
          disabled={!confirmed || phase === 'deleting' || switchedAccount}
          onClick={() => void requestDeletion()}
        >
          Permanently delete
        </Button>
      </div>
    );

  return (
    <SettingsCard
      id="your-data"
      title="Your data"
      description="Projects and deployed apps live in the Cloudflare account you build in."
    >
      {switchedAccount && session ? (
        <p className="mt-3 text-sm text-bolt-elements-icon-error" role="alert">
          You signed in again as {session.user.email}, a different account than the one you started with. Export and
          deletion are off here so they can&apos;t act on the wrong account; sign out and back in as the account you
          meant.
        </p>
      ) : null}

      <ul className="mt-4 grid divide-y divide-bolt-elements-borderColor rounded-md border border-bolt-elements-borderColor">
        <li className="grid min-w-0 gap-2 px-3 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1 basis-52">
              <h3 className="text-sm font-medium text-content-primary">Account data</h3>
              <p className="text-xs text-content-tertiary">Your CloudChef account record, as JSON.</p>
            </div>
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
          <details className="text-xs text-content-secondary">
            <summary className="cursor-pointer text-content-secondary">What’s included?</summary>
            <p className="mt-1">
              Your identity and email and your AI request logs setting; your own Cloudflare connection (its permissions
              and default model) and when its authorization was stored; your workspaces; your teams, the invites sent to
              you, your model use there, and the team projects you were given; your team project requests, each with the
              repository and commit it asks to publish; GitHub connections and approvals you started; emailed sign-in
              links; and sign-in and authorization session records. Credentials, credential handles, encryption vectors,
              session tokens, and the hashes links and invites are checked against are excluded.
            </p>
            <p className="mt-2">
              Chats, transcripts, project files, and deployment records are not included. They live in the Cloudflare
              account you build in. Use <strong>Download code</strong> for project source and Cloudflare’s tools for the
              rest.
            </p>
          </details>
          {exportPhase === 'reauthenticate' ? (
            <ReauthenticatePrompt
              className="text-sm text-content-secondary"
              reason="Sign in again to confirm it is you, then download again."
              next="download again"
              onError={setExportError}
            />
          ) : null}
          {unavailableSections.length > 0 ? (
            <p className="text-sm text-bolt-elements-icon-error" role="alert">
              CloudChef could not read {unavailableSections.map(accountExportSectionLabel).join(', ')}, so{' '}
              <code>{ACCOUNT_EXPORT_FILENAME}</code> is not a complete copy and says so inside. Try again, and if it
              keeps failing contact <Link to="/support">Support</Link>.
            </p>
          ) : exportPhase === 'downloaded' ? (
            <p className="text-sm text-content-secondary" role="status">
              Saved <code>{ACCOUNT_EXPORT_FILENAME}</code>.
            </p>
          ) : null}
          <FeedbackLine feedback={errorFeedback(exportError)} className="" />
        </li>
        <li className="min-w-0 px-3 py-3">
          <h3 className="text-sm font-medium text-content-primary">Project code</h3>
          <p className="text-xs text-content-tertiary">
            Use <strong>Download code</strong> in a project&apos;s header for a ZIP. Secret files are left out.
          </p>
        </li>
        <li className="min-w-0 px-3 py-3">
          <details className="text-xs text-content-tertiary">
            <summary className="cursor-pointer text-sm font-medium text-content-primary">Clear this browser</summary>
            <p className="mt-1">
              Logging out clears the in-memory project cache. Clear this site’s data in your browser settings to remove
              cookies, preferences, and tab-session state, in each browser and profile you used.
            </p>
          </details>
        </li>
      </ul>
      <p className="mt-2 text-xs text-content-tertiary">
        What CloudChef keeps:{' '}
        <Link className="underline" to="/privacy">
          Privacy notice
        </Link>
        . Other requests:{' '}
        <Link className="underline" to="/support">
          Support
        </Link>
        .
      </p>

      <div className="mt-5 rounded-md border border-red-600/40 px-3 py-3">
        {phase === 'deleted' ? (
          <div className="grid gap-2 text-sm text-content-secondary" role="status">
            <p>
              CloudChef erased your account identity, sessions, {keptOwnAuthorization ? '' : 'encrypted credentials, '}
              connection metadata, team memberships, and workspace addresses from its own database.
            </p>
            {workspacesLeftIn.length > 0 ? (
              <p className="text-bolt-elements-icon-error">
                Your workspace couldn&apos;t be deleted from the Cloudflare account of {workspacesLeftIn.join(', ')};
                ask its admins to remove it there.
              </p>
            ) : null}
            {keptOwnAuthorization ? (
              <p>
                Your Cloudflare authorization was kept, not erased, because {keptFor.join(', ')} still
                {keptFor.length === 1 ? ' builds' : ' build'} in your account, and it keeps working for{' '}
                {keptFor.length === 1 ? 'that team' : 'those teams'}. An admin there can reconnect it with their own
                Cloudflare login.
              </p>
            ) : null}
            {revoked === false || (hadOwnAccount && !keptOwnAuthorization && revoked === null) ? (
              <p>
                Cloudflare did not confirm the revocation. Remove the CloudChef authorization yourself in the Cloudflare
                dashboard under <strong>Profile → Manage OAuth authorizations</strong> (
                <a className="underline" href={CLOUDFLARE_OAUTH_AUTHORIZATIONS_URL}>
                  open OAuth authorizations
                </a>
                ).
                {keptOwnAuthorization
                  ? ` Removing it there also ends the access ${keptFor.join(', ')} still ${keptFor.length === 1 ? 'uses' : 'use'}.`
                  : null}
              </p>
            ) : hadOwnAccount && !keptOwnAuthorization ? (
              <p>Cloudflare confirmed that CloudChef’s authorization was revoked.</p>
            ) : null}
            <p>
              Resources CloudChef deployed are still in the Cloudflare accounts they were deployed to, and still billed
              to them. Clear this browser’s site data to remove its cookie, preferences, and tab-session state.
            </p>
            <p>
              <a className="underline" href="/">
                Return to CloudChef
              </a>
            </p>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1 basis-52">
              <h3 className="text-sm font-medium text-content-primary">Delete your CloudChef account</h3>
              <p className="text-xs text-content-tertiary">Can&apos;t be undone. Your Cloudflare resources stay.</p>
            </div>
            <Button size="sm" variant="danger" onClick={() => setPhase('confirming')}>
              Delete account data
            </Button>
          </div>
        )}
      </div>
      {phase === 'confirming' || phase === 'deleting' || phase === 'reauthenticate' ? (
        <Modal title="Delete your CloudChef account data?" onClose={phase === 'deleting' ? undefined : cancelDeletion}>
          <div className="grid gap-3 text-sm text-content-secondary">
            <p>
              Permanently erases your CloudChef account record, sessions, and stored credentials, and requests
              revocation of CloudChef’s access. Signing in again creates an empty account.
            </p>
            <ul className="grid list-disc gap-1.5 pl-5">
              <li>
                <strong className="text-content-primary">Your Cloudflare resources remain live and billable.</strong> To
                remove apps in your own account, delete their projects first and wait at least 30 minutes for cleanup.
                Afterwards CloudChef can&apos;t clean up for you.
              </li>
              <li>
                In a team, you leave it and your workspace there (your chats and project files) is deleted. Apps you
                deployed there stay with its admins. If you&apos;re its only admin, make someone else an admin first.
              </li>
              <li>Browser data is not cleared.</li>
            </ul>
            <label className="flex items-start gap-2">
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
            <label className="grid gap-1">
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
            {deletionControls}
            <FeedbackLine feedback={errorFeedback(error)} className="" />
          </div>
        </Modal>
      ) : null}
    </SettingsCard>
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
