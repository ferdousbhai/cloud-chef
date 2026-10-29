import { z } from 'zod';
import { publicOrigin } from '~/lib/.server/public-origin';
import {
  attachCloudflareIdentity,
  type CloudflareAuthSession,
  createAuthSession,
  getAuthSession,
  upsertCloudflareUser,
} from '~/lib/.server/auth';
import { isRecentSignIn, reauthenticationRequired } from '~/lib/.server/account-reauthentication';
import { IdentityConflictError } from '~/lib/.server/identity-conflict-error';
import {
  hasSameOrigin,
  readCookie,
  safeReturnTo,
  serializeCookie,
  withinAddressRateLimit,
} from '~/lib/.server/request-guards';
import { WORKSPACE_HEADER } from '~/lib/cloudflare/workspace-header';
import { canUseConnection, findMembership, isActiveAdmin } from '~/lib/cloudflare/data/organization-access.server';
import {
  activateCloudflareConnection,
  CloudflareConnectionChangedError,
  deleteUnusedCloudflareAuthorization,
  findActiveCloudflareConnection,
  findCloudflareAuthorization,
  findCloudflareConnectionForOwner,
  runsEveryOtherSpaceInAccount,
  type CloudflareConnectionOwner,
  type CloudflareConnection,
} from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import {
  CloudflareOAuthError,
  CloudflareOAuthOrchestrator,
  CloudflareOAuthUnavailableError,
  type CloudflareConnectionResult,
} from '~/lib/.server/cloudflare/cloudflare-oauth-orchestrator';
import { missingCoreOAuthScopes } from '~/lib/.server/cloudflare/cloudflare-oauth-scope-manifest';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';
import { workspaceRuntimeUpgradeAllowed } from '~/lib/.server/cloudflare/user-workspace-runtime-rollout';
import {
  isCurrentUserWorkspaceRuntime,
  startUserWorkspaceRuntimeProvisioning,
  type UserWorkspaceRuntimeProvisioningErrorCode,
} from '~/workflows/user-workspace-runtime-provisioning';
import {
  findUserWorkspaceRuntime,
  recordUserWorkspaceRuntimeSession,
  type UserWorkspaceRuntime,
} from '~/lib/.server/cloudflare/user-workspace-runtime-repository';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { mintRuntimeCapability } from '~/lib/cloudflare/runtime-capability';
import {
  CLOUDFLARE_AUTHORIZATION_ERROR_PARAM,
  CLOUDFLARE_AUTHORIZATION_ERROR_VALUE,
  CLOUDFLARE_CONNECT_MESSAGE_PARAM,
  type CloudflareConnectMessage,
} from '~/lib/cloudflare/authorization-recovery';

type WorkspacePreparationFailure = {
  code: UserWorkspaceRuntimeProvisioningErrorCode;
  error: string;
  upgradeUrl?: string;
};

const OAUTH_STATE_COOKIE = 'cloudchef_oauth_state';
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const OAUTH_START_RATE_LIMIT_RETRY_SECONDS = 60;
const MAX_OAUTH_START_REQUEST_BYTES = 4 * 1024;
const MAX_OAUTH_CALLBACK_CODE_LENGTH = 4_096;
const MAX_OAUTH_CALLBACK_TEXT_LENGTH = 2_048;
const RUNTIME_PROVISIONING_RETRY_HEADER = 'CloudChef-Runtime-Provisioning-Retry';
const WORKSPACE_PLAN_REQUIRED_MESSAGE =
  'Cloudflare Containers requires the Workers Paid plan. Enable Workers Paid in Cloudflare, then return here and try again. CloudChef does not change your plan automatically.';
const WORKSPACE_PREPARATION_FAILED_MESSAGE =
  'Cloudflare could not create your workspace. Check the Workers settings for this Cloudflare account, then try again.';
const WORKSPACE_ELIGIBILITY_UNKNOWN_MESSAGE =
  'CloudChef could not reach Cloudflare to confirm that this account can run Containers, so it did not start creating your workspace. Nothing changed in your Cloudflare account. Try again in a moment.';
const CLOUDFLARE_REAUTHORIZATION_REQUIRED_MESSAGE =
  'CloudChef needs updated Cloudflare permissions for this workspace. Reauthorize Cloudflare, approve the requested permissions, then try again.';
const startPayloadSchema = z.object({
  callbackURL: z.string().url().max(2_048).optional(),
  /** Set when an admin connects their organization's Cloudflare account rather than their own. */
  organizationId: z.string().uuid().optional(),
});
const callbackPayloadSchema = z
  .object({
    state: z.string().uuid(),
    code: z.string().min(1).max(MAX_OAUTH_CALLBACK_CODE_LENGTH).optional(),
    error: z.string().min(1).max(MAX_OAUTH_CALLBACK_TEXT_LENGTH).optional(),
    error_description: z.string().max(MAX_OAUTH_CALLBACK_TEXT_LENGTH).optional(),
    scope: z.string().max(MAX_OAUTH_CALLBACK_TEXT_LENGTH).optional(),
  })
  .refine((payload) => Boolean(payload.code || payload.error), 'An OAuth code or error is required.');
type PendingOAuthState = {
  provider_session_id: string;
  return_to: string;
  expires_at: number;
  /** Who was signed in when the connection started: the connection becomes theirs. */
  linking_user_id: string | null;
  /** The organization whose account is being connected, by its admin `linking_user_id`. */
  connecting_org_id: string | null;
};

class InvalidCloudflareIntegrationRequestError extends Error {}

export async function cloudflareConnectionStatusAction({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Cloudflare authentication required.' }, { status: 401 });
  }
  const connection = await sessionConnection(env.DB, session);
  if (!connection) {
    return Response.json({ error: 'An active Cloudflare account is required.' }, { status: 401 });
  }

  return Response.json(
    {
      accountId: connection.accountId,
      accountName: connection.accountName,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/**
 * The Cloudflare account the session builds in, while the person may still use it: their own active
 * connection, or an active one of an organization they are an unpaused member of.
 */
export async function sessionConnection(
  db: D1Database,
  session: CloudflareAuthSession,
): Promise<CloudflareConnection | null> {
  if (!session.context) {
    return null;
  }
  const connection = await findActiveCloudflareConnection(db, session.context.connectionId);
  return connection && (await canUseConnection(db, session.user.id, connection)) ? connection : null;
}

export async function cloudflareRuntimeSessionAction({
  request,
  env,
  provision = startUserWorkspaceRuntimeProvisioning,
}: {
  request: Request;
  env: Env;
  provision?: typeof startUserWorkspaceRuntimeProvisioning;
}): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Cloudflare authentication required.' }, { status: 401 });
  }
  const connection = await sessionConnection(env.DB, session);
  if (!connection) {
    return Response.json({ error: 'Connect Cloudflare before opening a project.' }, { status: 409 });
  }
  // The tab opened in another account than the session now uses (switched in another tab): it reloads
  // rather than send its work into an account it isn't showing.
  const expected = request.headers.get(WORKSPACE_HEADER);
  if (expected && expected !== connection.id) {
    return Response.json(
      { code: 'workspace_switched', error: 'You switched accounts in another tab.' },
      { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  if (!env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
    return Response.json({ error: 'Runtime authorization is unavailable.' }, { status: 503 });
  }
  if (missingCoreOAuthScopes(connection.grantedOAuthScopes).length > 0) {
    return Response.json(
      {
        code: 'cloudflare_reauthorization_required',
        error: CLOUDFLARE_REAUTHORIZATION_REQUIRED_MESSAGE,
      },
      { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  const found = await findUserWorkspaceRuntime(env.DB, session.user.id, connection.id);
  const usable = usableWorkspaceRuntime(found, connection);
  const provisioning = {
    env,
    userId: session.user.id,
    connectionId: connection.id,
    connectionGeneration: connection.generation,
    retry: request.headers.get(RUNTIME_PROVISIONING_RETRY_HEADER) === '1',
    isReady: async () =>
      isCurrentWorkspaceRuntime(await findUserWorkspaceRuntime(env.DB, session.user.id, connection.id), connection),
  };
  if (!usable) {
    try {
      const started = await provision(provisioning);
      if (started.status === 'error') {
        return workspaceProvisioningFailureResponse(started.errorCode, started.upgradeUrl);
      }
    } catch (error) {
      console.error('Unable to submit the workspace provisioning Workflow', error);
      return workspaceProvisioningFailureResponse('workspace_preparation_failed', null);
    }
    return Response.json(
      {
        code: 'workspace_preparing',
        error: 'CloudChef is still preparing your workspace.',
        // An existing workspace is being upgraded to this CloudChef release, not set up for the first time.
        upgrading: found !== null,
      },
      {
        status: 409,
        headers: {
          'Cache-Control': 'private, no-store',
        },
      },
    );
  }
  const { runtime, upgradePending } = usable;
  // During a canary only the named people's runtimes are upgraded; everyone else's keeps serving as it is.
  if (upgradePending && workspaceRuntimeUpgradeAllowed(env, session.user.id)) {
    // The runtime is from an earlier release but speaks this one's protocol: the browser keeps working
    // with it while the upgrade waits, in the background, for a moment nothing is running in it.
    await provision(provisioning).then(
      (started) => {
        if (started.status === 'error') {
          console.warn({ event: 'runtime_upgrade_unavailable', errorCode: started.errorCode });
        }
      },
      (error: Error) => console.error('Unable to submit the workspace upgrade Workflow', error.message),
    );
  }
  await recordUserWorkspaceRuntimeSession(env.DB, { userId: session.user.id, connectionId: connection.id });
  const secret = await deriveUserWorkspaceRuntimeSecret({
    encryptionKeyBase64: env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY,
    userId: session.user.id,
    accountId: connection.accountId,
    connectionGeneration: connection.generation,
    organizationConnectionId: connection.orgId ? connection.id : null,
  });
  // The control plane owns the browser/server join key. Minting it here and
  // logging it beside this grant lets an incident responder line up opted-in
  // browser funnel events with the request that issued the runtime session,
  // without the browser's journey ID ever reaching the server as an identifier.
  const correlationId = crypto.randomUUID();
  console.info({
    event: 'runtime_session_issued',
    correlationId,
    connectionGeneration: connection.generation,
    runtimeVersion: runtime.runtimeVersion,
    upgradePending,
  });
  const capability = await mintRuntimeCapability({
    secret,
    subject: session.user.id,
    origin: new URL(request.url).origin,
  });
  return Response.json(
    { endpoint: runtime.endpoint, ...capability, correlationId },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

function workspaceProvisioningFailureResponse(
  code: UserWorkspaceRuntimeProvisioningErrorCode,
  upgradeUrl: string | null,
): Response {
  if (code === 'workspace_eligibility_unknown') {
    return Response.json(
      { code, error: WORKSPACE_ELIGIBILITY_UNKNOWN_MESSAGE },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  const body: WorkspacePreparationFailure = {
    code,
    error: code === 'workspace_plan_required' ? WORKSPACE_PLAN_REQUIRED_MESSAGE : WORKSPACE_PREPARATION_FAILED_MESSAGE,
  };
  if (code === 'workspace_plan_required' && upgradeUrl) {
    body.upgradeUrl = upgradeUrl;
  }
  return Response.json(body, { status: 502, headers: { 'Cache-Control': 'private, no-store' } });
}

/**
 * The runtime a session can be issued for: the current one, or one from an earlier release that serves
 * this connection generation and speaks this release's protocol, whose upgrade then waits for a safe
 * moment. A runtime for another connection generation holds a secret that no longer authenticates, and
 * one that speaks another protocol cannot serve this release's browser: both are prepared again first.
 */
export function usableWorkspaceRuntime(
  runtime: UserWorkspaceRuntime | null,
  connection: CloudflareConnection,
): { runtime: UserWorkspaceRuntime; upgradePending: boolean } | null {
  if (
    runtime === null ||
    runtime.connectionId !== connection.id ||
    runtime.connectionGeneration !== connection.generation
  ) {
    return null;
  }
  if (isCurrentWorkspaceRuntime(runtime, connection)) {
    return { runtime, upgradePending: false };
  }
  return runtime.protocolVersion === USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION ? { runtime, upgradePending: true } : null;
}

function isCurrentWorkspaceRuntime(runtime: UserWorkspaceRuntime | null, connection: CloudflareConnection): boolean {
  return (
    runtime !== null &&
    runtime.connectionId === connection.id &&
    runtime.connectionGeneration === connection.generation &&
    isCurrentUserWorkspaceRuntime(runtime)
  );
}

export async function startCloudflareConnectionAction(args: {
  request: Request;
  env: Env;
  orchestrator?: Pick<CloudflareOAuthOrchestrator, 'startConnection'>;
}): Promise<Response> {
  try {
    if (!hasSameOrigin(args.request)) {
      return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
    }
    if (!(await withinAddressRateLimit(args.env.CLOUDFLARE_OAUTH_START_RATE_LIMITER, args.request))) {
      return Response.json(
        { error: 'Too many Cloudflare authorization attempts. Try again shortly.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(OAUTH_START_RATE_LIMIT_RETRY_SECONDS),
            'Cache-Control': 'no-store',
          },
        },
      );
    }
    const payload = parseIntegrationRequest(
      startPayloadSchema,
      await readJsonBodyWithLimit(args.request, MAX_OAUTH_START_REQUEST_BYTES, 'Cloudflare authorization request'),
    );
    // Someone signed in by email or Google connects Cloudflare to their own CloudChef account, or, as
    // an admin, to their organization.
    const signedIn = await getAuthSession(args.env, args.request);
    // Attaching a new Cloudflare login to a signed-in account needs a recent sign-in, like export and
    // erasure: it changes how the account itself can be signed into. Connecting an organization doesn't:
    // the admin approves it on Cloudflare, which is check enough.
    if (
      signedIn &&
      !payload.organizationId &&
      !isRecentSignIn(signedIn) &&
      !(await hasCloudflareLogin(args.env.DB, signedIn.user.id))
    ) {
      return reauthenticationRequired('Sign in again to confirm it is you, then connect Cloudflare.');
    }
    if (payload.organizationId) {
      const membership = signedIn ? await findMembership(args.env.DB, payload.organizationId, signedIn.user.id) : null;
      if (!isActiveAdmin(membership)) {
        return Response.json({ error: "Only a team's admin can connect its Cloudflare account." }, { status: 403 });
      }
    }
    const state = crypto.randomUUID();
    const requestUrl = new URL(args.request.url);
    const returnUrl = new URL('/connect/return', publicOrigin(args.request));
    returnUrl.searchParams.set('state', state);
    const orchestrator = args.orchestrator ?? CloudflareOAuthOrchestrator.fromEnv(args.env);
    const challenge = await orchestrator.startConnection({ returnUrl: returnUrl.toString() });
    const now = Date.now();
    await args.env.DB.prepare(
      `INSERT INTO cloudflare_oauth_states
        (id, provider_session_id, return_to, status, expires_at, created_at, updated_at, linking_user_id,
         connecting_org_id)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
      .bind(
        state,
        challenge.sessionId,
        safeReturnTo(payload.callbackURL, requestUrl.origin),
        challenge.expiresAt,
        now,
        now,
        signedIn?.user.id ?? null,
        payload.organizationId ?? null,
      )
      .run();
    return Response.json(
      { authorizationUrl: challenge.authorizationUrl, expiresAt: challenge.expiresAt },
      {
        status: 201,
        headers: { 'Set-Cookie': oauthStateCookie(state, OAUTH_STATE_COOKIE_MAX_AGE_SECONDS, args.request) },
      },
    );
  } catch (error) {
    return cloudflareIntegrationErrorResponse(error);
  }
}

/**
 * Cloudflare's return after authorizing, a top-level browser navigation: every outcome goes back to
 * CloudChef, a failure to Settings saying what happened (`connectReturnFailure`).
 */
export async function completeCloudflareConnectionAction(args: {
  request: Request;
  env: Env;
  orchestrator?: Pick<CloudflareOAuthOrchestrator, 'completeConnection'>;
}): Promise<Response> {
  let returnTo: string | null = null;
  try {
    const { state, callbackUrl, providerRejectedAuthorization } = await readCloudflareCallback(args.request);
    if (readCookie(args.request, OAUTH_STATE_COOKIE) !== state) {
      throw new ConnectReturnError('other_browser');
    }
    const oauthState = await args.env.DB.prepare(
      `SELECT provider_session_id, return_to, expires_at, linking_user_id, connecting_org_id
       FROM cloudflare_oauth_states
       WHERE id = ? AND status = 'pending'`,
    )
      .bind(state)
      .first<PendingOAuthState>();
    if (!oauthState) {
      throw new ConnectReturnError('already_finished');
    }
    returnTo = oauthState.return_to;
    if (oauthState.expires_at <= Date.now()) {
      await args.env.DB.prepare(
        `UPDATE cloudflare_oauth_states SET status = 'expired', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
        .bind(Date.now(), state)
        .run();
      throw new ConnectReturnError('expired');
    }
    if (providerRejectedAuthorization) {
      await settleOAuthState(args.env.DB, state, 'error', null);
      return cloudflareAuthorizationRecoveryResponse(args.request, oauthState.return_to);
    }
    if (!args.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
      throw new Error('Cloudflare credential encryption is not configured.');
    }

    const orgId = oauthState.connecting_org_id;
    const orchestrator = args.orchestrator ?? CloudflareOAuthOrchestrator.fromEnv(args.env);
    const result = await orchestrator.completeConnection({
      providerSessionId: oauthState.provider_session_id,
      callbackUrl,
    });
    const holder = await args.env.DB.prepare('SELECT id FROM "user" WHERE cloudflare_subject = ?')
      .bind(result.user.subject)
      .first<{ id: string }>();
    // A signed-in person who came back from Cloudflare with the login already on their account proved
    // who they are again, like a fresh sign-in: their session is replaced with a new one.
    const reproved = oauthState.linking_user_id !== null && holder?.id === oauthState.linking_user_id;
    // Who is connecting, and which space: a team's, connected by one of its admins with their own Cloudflare
    // login, or the person's own. Signing in with a Cloudflare login CloudChef doesn't know yet is no one so
    // far: their user is created only once nothing refuses the connection.
    const teamAdmin = orgId ? await requireTeamAdmin(args.env.DB, orgId, oauthState.linking_user_id) : null;
    const connectingUserId = teamAdmin ?? oauthState.linking_user_id ?? holder?.id ?? null;
    let owner: CloudflareConnectionOwner | null = orgId
      ? { kind: 'organization', orgId }
      : connectingUserId
        ? { kind: 'user', userId: connectingUserId }
        : null;
    const previous = owner ? await findCloudflareConnectionForOwner(args.env.DB, owner) : null;
    const vault = D1CloudflareCredentialVault.fromEnv(args.env);
    const replaced = await authorizationToReplace(args.env.DB, vault, {
      userId: connectingUserId,
      owner,
      previous,
      accountId: result.accountId,
    });
    let userId: string;
    if (teamAdmin && owner) {
      userId = teamAdmin;
    } else {
      const linkingUserId = oauthState.linking_user_id;
      const user = await (
        linkingUserId
          ? attachCloudflareIdentity(args.env.DB, linkingUserId, result.user.subject)
          : upsertCloudflareUser(args.env.DB, result.user, result.accountName)
      ).catch((error: Error) => {
        throw error instanceof IdentityConflictError
          ? new ConnectReturnError(linkingUserId ? 'login_linked_elsewhere' : 'email_has_account')
          : error;
      });
      userId = user.id;
      owner = { kind: 'user', userId };
    }
    const credentialHandle = await vault.storeOAuthCredential({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.accessTokenExpiresAt,
    });
    try {
      await activateCloudflareConnection({
        db: args.env.DB,
        owner,
        accountId: result.accountId,
        accountName: result.accountName,
        credentialHandle,
        grantedOAuthScopes: result.grantedOAuthScopes,
        expectedGeneration: previous?.generation ?? null,
        replacedCredentialHandle: replaced,
      });
    } catch (error) {
      const racedConnection =
        error instanceof CloudflareConnectionChangedError
          ? await findCloudflareConnectionForOwner(args.env.DB, owner).catch((readError) => {
              console.warn('Unable to read raced Cloudflare connection', readError);
              return null;
            })
          : null;
      const canAdoptRace =
        racedConnection && isEquivalentRacedConnection(racedConnection, owner, result, previous?.generation ?? null);
      await vault.deleteIfUnreferenced(credentialHandle).catch((cleanupError) => {
        console.warn('Unable to clean up orphaned Cloudflare credential', cleanupError);
      });
      if (!canAdoptRace) {
        // Another connection changed this space or the account's authorization meanwhile: nothing was written,
        // and connecting again decides afresh.
        throw error instanceof CloudflareConnectionChangedError ? new ConnectReturnError('changed_meanwhile') : error;
      }
    }
    // A space that moved to another account leaves that account's authorization behind once nothing builds there.
    if (previous && previous.accountId !== result.accountId) {
      await deleteUnusedCloudflareAuthorization(args.env.DB, previous.accountId)
        .run()
        .catch((cleanupError: Error) => {
          console.warn('Unable to clean up an unused Cloudflare authorization', cleanupError.message);
        });
    }
    // The credentials this connection replaced, removed once nothing names them: the authorization the account
    // had (whoever connected it), and the one of the account this space built in before, if it moved.
    const replacedHandles = new Set([previous?.credentialHandle, replaced]);
    for (const handle of replacedHandles) {
      if (handle && handle !== credentialHandle) {
        await vault.deleteIfUnreferenced(handle).catch((cleanupError) => {
          console.warn('Unable to clean up a replaced Cloudflare credential', cleanupError);
        });
      }
    }
    // Signing in with Cloudflare starts a session. Connecting while already signed in (your own account,
    // or an organization's) doesn't: the session that asked keeps going, now in the account just
    // connected. A new one would count as a fresh sign-in, which export and erasure rely on.
    let sessionId: string;
    let sessionCookie: string | null = null;
    if (oauthState.linking_user_id) {
      const current = await getAuthSession(args.env, args.request);
      if (current?.user.id !== oauthState.linking_user_id) {
        // The connection is already active by now: only this browser's session is gone.
        throw new ConnectReturnError('session_ended');
      }
      sessionId = current.session.id;
      if (reproved) {
        const fresh = await createAuthSession(args.env, userId, args.request);
        sessionCookie = fresh.cookie;
        await args.env.DB.prepare('DELETE FROM cloudflare_auth_sessions WHERE id = ?').bind(current.session.id).run();
        sessionId = fresh.id;
      }
    } else {
      const created = await createAuthSession(args.env, userId, args.request);
      sessionCookie = created.cookie;
      sessionId = created.id;
    }
    await args.env.DB.prepare(
      `UPDATE cloudflare_auth_sessions SET context_connection_id = (
         SELECT id FROM cloudflare_connections WHERE ${owner.kind === 'user' ? 'user_id' : 'org_id'} = ?
       ) WHERE id = ?`,
    )
      .bind(owner.kind === 'user' ? owner.userId : owner.orgId, sessionId)
      .run();
    await settleOAuthState(args.env.DB, state, 'completed', userId);
    const headers = new Headers({
      Location: new URL(
        safeReturnTo(oauthState.return_to, new URL(args.request.url).origin),
        args.request.url,
      ).toString(),
    });
    if (sessionCookie) {
      headers.append('Set-Cookie', sessionCookie);
    }
    headers.append('Set-Cookie', oauthStateCookie('', 0, args.request));
    return new Response(null, {
      status: 303,
      headers,
    });
  } catch (error) {
    if (error instanceof ConnectReturnError) {
      return connectReturnFailure(args.request, returnTo, error.code);
    }
    if (error instanceof CloudflareOAuthError) {
      // Its message can name scopes Cloudflare returned; the person gets fixed text and the log the detail.
      console.warn({ event: 'cloudflare_connect_incomplete', message: error.message });
      return connectReturnFailure(args.request, returnTo, 'authorization_incomplete');
    }
    // Anything else is classified (and an unexpected one logged) as the JSON routes do.
    const unexpected = cloudflareIntegrationErrorResponse(error).status >= 500;
    return connectReturnFailure(args.request, returnTo, unexpected ? 'unavailable' : 'unreadable');
  }
}

/** The active admin of the team `orgId` who is connecting it; refuses anyone else. */
async function requireTeamAdmin(db: D1Database, orgId: string, linkingUserId: string | null): Promise<string> {
  const membership = linkingUserId ? await findMembership(db, orgId, linkingUserId) : null;
  if (!linkingUserId || !isActiveAdmin(membership)) {
    throw new ConnectReturnError('admin_only');
  }
  return linkingUserId;
}

/**
 * The credential of the account's authorization as it is now, which this connection replaces (compare-and-set),
 * or null when the account has none. It is shared by every space building in that account, so a space newly
 * coming into the account while it works is refused (`account_in_use`) unless `userId` runs each of those
 * spaces. A space reconnecting the account it already builds in is that space's own reconnect, made by someone
 * with access to that Cloudflare account, and is never refused. One that no longer works (missing a permission
 * CloudChef needs, or its grant gone) anyone connecting there may replace, so an account is never left with
 * nobody able to.
 */
async function authorizationToReplace(
  db: D1Database,
  vault: D1CloudflareCredentialVault,
  args: {
    userId: string | null;
    owner: CloudflareConnectionOwner | null;
    previous: CloudflareConnection | null;
    accountId: string;
  },
): Promise<string | null> {
  const current = await findCloudflareAuthorization(db, args.accountId);
  if (
    current &&
    args.previous?.accountId !== args.accountId &&
    missingCoreOAuthScopes(current.grantedOAuthScopes).length === 0 &&
    !(await runsEveryOtherSpaceInAccount(db, args)) &&
    (await vault.stillAuthorizes(current.credentialHandle))
  ) {
    throw new ConnectReturnError('account_in_use');
  }
  return current?.credentialHandle ?? null;
}

/** A return from Cloudflare that cannot finish, with the code of what to tell the person. */
class ConnectReturnError extends Error {
  constructor(readonly code: CloudflareConnectMessage) {
    super(code);
  }
}

/**
 * Back to Settings (keeping where the person was headed) with why the return from Cloudflare did not
 * finish, and this browser's authorization state cleared. The URL carries a code Settings shows as text.
 */
function connectReturnFailure(request: Request, returnTo: string | null, code: CloudflareConnectMessage): Response {
  return settingsAfterConnectReturn(request, returnTo, [CLOUDFLARE_CONNECT_MESSAGE_PARAM, code]);
}

/** Settings' Cloudflare card, carrying where the person was headed (`continue`) and why they are there. */
function settingsAfterConnectReturn(
  request: Request,
  returnTo: string | null,
  [param, value]: [string, string],
): Response {
  const requestUrl = new URL(request.url);
  const continuation = returnTo === null ? '/settings' : safeReturnTo(returnTo, requestUrl.origin);
  const originalTarget = new URL(continuation, requestUrl.origin);
  const target = originalTarget.pathname === '/settings' ? originalTarget : new URL('/settings', requestUrl.origin);
  if (originalTarget.pathname !== '/settings') {
    target.searchParams.set('continue', continuation);
  }
  target.searchParams.set(param, value);
  target.hash = 'cloudflare';
  return new Response(null, {
    status: 303,
    headers: {
      Location: target.toString(),
      'Cache-Control': 'no-store',
      'Set-Cookie': oauthStateCookie('', 0, request),
    },
  });
}

async function hasCloudflareLogin(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS linked FROM "user" WHERE id = ? AND cloudflare_subject IS NOT NULL')
    .bind(userId)
    .first<{ linked: number }>();
  return row !== null;
}

function isEquivalentRacedConnection(
  connection: CloudflareConnection,
  owner: CloudflareConnectionOwner,
  result: CloudflareConnectionResult,
  expectedGeneration: number | null,
): boolean {
  return (
    connection.status === 'active' &&
    (owner.kind === 'user' ? connection.userId === owner.userId : connection.orgId === owner.orgId) &&
    connection.credentialHandle !== null &&
    connection.accountId === result.accountId &&
    connection.accountName === result.accountName &&
    connection.generation === (expectedGeneration ?? 0) + 1 &&
    sameStringArray(connection.grantedOAuthScopes, result.grantedOAuthScopes)
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Settles a still-pending authorization state as completed by `userId`, or as the provider's refusal. */
async function settleOAuthState(
  db: D1Database,
  stateId: string,
  status: 'completed' | 'error',
  userId: string | null,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE cloudflare_oauth_states SET status = ?, authenticated_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(status, userId, Date.now(), stateId)
    .run();
  if (result.meta.changes !== 1) {
    throw new Error(`Cloudflare authorization state changed before it could be recorded as ${status}.`);
  }
}

async function readCloudflareCallback(
  request: Request,
): Promise<{ state: string; callbackUrl: string; providerRejectedAuthorization: boolean }> {
  const requestUrl = new URL(request.url);
  const payload = parseIntegrationRequest(callbackPayloadSchema, Object.fromEntries(requestUrl.searchParams));
  const callbackUrl = new URL(requestUrl.pathname, publicOrigin(request));
  for (const key of ['state', 'code', 'error', 'error_description', 'scope'] as const) {
    const value = payload[key];
    if (value) {
      callbackUrl.searchParams.set(key, value);
    }
  }
  return {
    state: payload.state,
    callbackUrl: callbackUrl.toString(),
    providerRejectedAuthorization: Boolean(payload.error),
  };
}

function cloudflareAuthorizationRecoveryResponse(request: Request, returnTo: string): Response {
  return settingsAfterConnectReturn(request, returnTo, [
    CLOUDFLARE_AUTHORIZATION_ERROR_PARAM,
    CLOUDFLARE_AUTHORIZATION_ERROR_VALUE,
  ]);
}

function parseIntegrationRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InvalidCloudflareIntegrationRequestError('Invalid Cloudflare authorization request.');
  }
  return result.data;
}

function oauthStateCookie(value: string, maxAge: number, request: Request): string {
  return serializeCookie({ name: OAUTH_STATE_COOKIE, value, path: '/connect/return', maxAge, request });
}

function cloudflareIntegrationErrorResponse(error: unknown): Response {
  if (error instanceof PayloadTooLargeError) {
    return Response.json({ error: error.message }, { status: 413 });
  }
  if (error instanceof InvalidJsonBodyError) {
    return Response.json({ error: 'Invalid Cloudflare authorization request.' }, { status: 400 });
  }
  if (error instanceof InvalidCloudflareIntegrationRequestError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof CloudflareOAuthUnavailableError) {
    return Response.json({ error: 'Cloudflare OAuth is not configured for this environment.' }, { status: 503 });
  }
  if (error instanceof CloudflareOAuthError || error instanceof IdentityConflictError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof z.ZodError) {
    return Response.json({ error: 'Invalid Cloudflare authorization response.' }, { status: 502 });
  }
  console.error('Cloudflare authorization failed');
  return Response.json({ error: 'Cloudflare authorization failed.' }, { status: 500 });
}
