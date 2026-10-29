import { useState } from 'react';
import { Button } from '@ui/Button';
import { ReauthenticatePrompt } from '~/components/settings/ReauthenticatePrompt';
import {
  authClient,
  createCloudflareReturnURL,
  ReauthenticationRequiredError,
  signInWithCloudflare,
} from '~/lib/auth-client';
import { cloudflareReauthorizationRequiredStore, UserRuntimeSessionError } from '~/lib/cloudflare/runtime-session';
import { messageOf, RequestError } from '~/lib/json-request';
import { classNames } from '~/utils/classNames';

const OPEN_WORKSPACE = 'open your workspace';

/** What the prompt says to someone who can approve the permissions, before what they're needed for. */
function reauthorizeCloudflareMessage(blocked = OPEN_WORKSPACE): string {
  return `CloudChef needs a few more Cloudflare permissions before it can ${blocked}. Reauthorize Cloudflare to approve them.`;
}

/** What it says to a team member who isn't an admin, so can't. */
function askAdminToReauthorizeMessage(blocked = OPEN_WORKSPACE): string {
  return `CloudChef needs a few more Cloudflare permissions before it can ${blocked}. Ask your team's admin to reauthorize Cloudflare.`;
}

export const REAUTHORIZE_CLOUDFLARE_MESSAGE = reauthorizeCloudflareMessage();
export const ASK_ADMIN_TO_REAUTHORIZE_MESSAGE = askAdminToReauthorizeMessage();

/** Whether a failure is CloudChef's answer that the Cloudflare connection needs its permissions approved again. */
export function needsCloudflareReauthorization(error: Error | null | undefined): boolean {
  return (
    (error instanceof UserRuntimeSessionError || error instanceof RequestError) &&
    error.code === 'cloudflare_reauthorization_required'
  );
}

/**
 * Notes a failure that needs Cloudflare reauthorized, so the page's one prompt shows; true when it was one, and
 * the caller then says nothing of its own about it.
 */
export function noteCloudflareReauthorization(error: Error | null | undefined): boolean {
  if (!needsCloudflareReauthorization(error)) {
    return false;
  }
  cloudflareReauthorizationRequiredStore.set(true);
  return true;
}

/**
 * The one prompt shown where Cloudflare permissions a release added block the workspace: a single button that
 * reauthorizes the connection being worked in (the person's own, or the team's for its admin). A team member who
 * isn't an admin can't grant them, so is told who can.
 */
export function CloudflareReauthorizePrompt({
  blocked,
  className,
}: {
  /** What the permissions are needed for, as "before it can …": opening the workspace unless said. */
  blocked?: string;
  className?: string;
}) {
  const { data: session } = authClient.useSession();
  const team = session?.context?.kind === 'organization' ? session.context : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInAgain, setSignInAgain] = useState<string | null>(null);

  const reauthorize = async () => {
    setBusy(true);
    setError(null);
    try {
      if (
        !(await signInWithCloudflare(
          createCloudflareReturnURL(window.location.href),
          team ? { organizationId: team.orgId } : {},
        ))
      ) {
        setBusy(false);
      }
    } catch (cause) {
      if (cause instanceof ReauthenticationRequiredError) {
        setSignInAgain(cause.message);
      } else {
        setError(messageOf(cause, 'Cloudflare couldn’t be reached. Try again.'));
      }
      setBusy(false);
    }
  };

  const canGrant = team === null || team.role === 'admin';
  return (
    <div
      role="status"
      aria-label="Cloudflare permissions needed"
      className={classNames(
        'grid justify-items-start gap-3 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-4 text-sm text-content-secondary',
        className,
      )}
    >
      <p className="text-content-primary">
        {canGrant ? reauthorizeCloudflareMessage(blocked) : askAdminToReauthorizeMessage(blocked)}
      </p>
      {!canGrant ? null : signInAgain ? (
        <ReauthenticatePrompt
          reason={signInAgain}
          next="select Reauthorize Cloudflare again"
          onError={setError}
          className="text-content-secondary"
        />
      ) : (
        <Button size="sm" variant="primary" loading={busy} onClick={() => void reauthorize()}>
          Reauthorize Cloudflare
        </Button>
      )}
      {error ? (
        <p className="text-bolt-elements-icon-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The prompt alone in the middle of a page whose workspace it blocks, such as a project or its chat. */
export function CloudflareReauthorizePanel() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-5">
      <CloudflareReauthorizePrompt className="m-auto w-full max-w-md shrink-0" />
    </div>
  );
}
