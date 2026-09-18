import { z } from 'zod';
import { bytesToBase64Url } from '~/lib/hex-digest';
import {
  BROAD_CLOUDFLARE_OAUTH_SCOPES,
  capabilitiesFromOAuthScopes,
  CLOUDFLARE_OAUTH_SCOPE_PROFILE_VERSION,
  cloudflareOAuthScopeGrantStatus,
  CORE_CLOUDFLARE_OAUTH_SCOPES,
  missingCoreOAuthScopes,
  parseReportedOAuthScopes,
} from './cloudflare-oauth-scope-manifest';
import {
  CloudflareOAuthError,
  type CloudflareConnectionChallenge,
  type CloudflareConnectionCompletionRequest,
  type CloudflareConnectionRequest,
  type CloudflareConnectionResult,
  type CloudflareOrchestrator,
} from './cloudflare-orchestrator';

export { CloudflareOAuthError } from './cloudflare-orchestrator';

const AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';
const TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const USER_DETAILS_URL = 'https://api.cloudflare.com/client/v4/user';
const ACCOUNTS_URL = 'https://api.cloudflare.com/client/v4/accounts?per_page=2';
const SESSION_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

type OAuthSession = {
  verifier: string;
  redirectUri: string;
};

const oauthSessionSchema = z.object({
  verifier: z.string(),
  redirectUri: z.string(),
}) satisfies z.ZodType<OAuthSession>;

/**
 * Cloudflare's own responses. Every field is optional and self-healing so a payload Cloudflare
 * changes in a way this code does not model still reaches the explicit checks below, which raise the
 * message an operator can act on rather than a decoding failure.
 */
const optionalText = z.string().optional().catch(undefined);

const tokenExchangeSchema = z.looseObject({
  access_token: optionalText,
  refresh_token: optionalText,
  scope: optionalText,
  expires_in: z.number().optional().catch(undefined),
});

const userDetailsSchema = z.looseObject({
  success: z.boolean().optional().catch(undefined),
  result: z
    .looseObject({
      id: optionalText,
      email: optionalText,
      first_name: optionalText,
      last_name: optionalText,
    })
    .optional()
    .catch(undefined),
});

const accountsSchema = z.looseObject({
  success: z.boolean().optional().catch(undefined),
  result: z
    .array(z.looseObject({ id: optionalText, name: optionalText }))
    .optional()
    .catch(undefined),
});

export class CloudflareOAuthOrchestrator implements CloudflareOrchestrator {
  constructor(
    private readonly config: { clientId: string; clientSecret: string; scopes: string },
    private readonly request: typeof fetch = fetch,
  ) {}

  async startConnection(request: CloudflareConnectionRequest): Promise<CloudflareConnectionChallenge> {
    const configuredScopes = new Set(this.config.scopes.split(/\s+/).filter(Boolean));
    const missingScopes = CORE_CLOUDFLARE_OAUTH_SCOPES.filter((scope) => !configuredScopes.has(scope));
    if (missingScopes.length > 0) {
      throw new CloudflareOAuthError(`Cloudflare OAuth is missing required scopes: ${missingScopes.join(', ')}.`);
    }
    const returnUrl = new URL(request.returnUrl);
    const state = returnUrl.searchParams.get('state');
    if (!state) {
      throw new CloudflareOAuthError('Cloudflare OAuth state is missing.');
    }
    returnUrl.search = '';
    const verifier = randomBase64Url(48);
    const challenge = bytesToBase64Url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
    const authorizationUrl = new URL(AUTHORIZE_URL);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', this.config.clientId);
    authorizationUrl.searchParams.set('redirect_uri', returnUrl.toString());
    authorizationUrl.searchParams.set('scope', [...configuredScopes, 'offline_access'].join(' '));
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    return {
      sessionId: JSON.stringify({
        verifier,
        redirectUri: returnUrl.toString(),
      } satisfies OAuthSession),
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
    };
  }

  async completeConnection(request: CloudflareConnectionCompletionRequest): Promise<CloudflareConnectionResult> {
    const execute = this.request;
    const session = parseSession(request.providerSessionId);
    const callback = new URL(request.callbackUrl);
    const providerError = callback.searchParams.get('error');
    if (providerError) {
      throw new CloudflareOAuthError('Cloudflare authorization was declined or could not be completed.');
    }
    const code = callback.searchParams.get('code');
    if (!code) {
      throw new CloudflareOAuthError('Cloudflare authorization code is missing.');
    }
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      code,
      redirect_uri: session.redirectUri,
      code_verifier: session.verifier,
    });
    const tokenResponse = await execute(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${this.config.clientId}:${this.config.clientSecret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    });
    const token = tokenExchangeSchema.safeParse(await tokenResponse.json().catch(() => null)).data;
    if (!tokenResponse.ok || !token?.access_token) {
      throw new CloudflareOAuthError('Cloudflare token exchange failed.');
    }
    if (!token.refresh_token) {
      throw new CloudflareOAuthError(
        'Cloudflare did not issue a refresh token. Reconnect with offline access enabled.',
      );
    }
    const requestedScopes = [...new Set(this.config.scopes.split(/\s+/).filter(Boolean))];
    const grantedScopes = resolveGrantedScopes(
      token.scope ?? callback.searchParams.get('scope') ?? undefined,
      requestedScopes,
    );
    const userDetailsResponse = await execute(USER_DETAILS_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    });
    const userDetailsPayload = userDetailsSchema.safeParse(await userDetailsResponse.json().catch(() => null)).data;
    const userDetails = userDetailsPayload?.result;
    if (!userDetailsResponse.ok || userDetailsPayload?.success !== true || !userDetails?.id) {
      throw new CloudflareOAuthError('Cloudflare did not return an authenticated user identity.');
    }
    const accountsResponse = await execute(ACCOUNTS_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    });
    const accountsPayload = accountsSchema.safeParse(await accountsResponse.json().catch(() => null)).data;
    const accounts = accountsPayload?.result ?? [];
    if (!accountsResponse.ok || accountsPayload?.success !== true || accounts.length !== 1) {
      throw new CloudflareOAuthError('Select exactly one Cloudflare account when authorizing CloudChef.');
    }
    const account = accounts[0];
    if (!account.id) {
      throw new CloudflareOAuthError('Cloudflare did not return an authorized account.');
    }
    return {
      user: {
        subject: userDetails.id,
        email: userDetails.email ?? null,
        name: [userDetails.first_name, userDetails.last_name].filter(Boolean).join(' ') || null,
        picture: null,
      },
      accountId: account.id,
      accountName: account.name ?? null,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt:
        typeof token.expires_in === 'number' ? Date.now() + Math.max(0, token.expires_in) * 1_000 : undefined,
      grantedCapabilities: capabilitiesFromOAuthScopes(grantedScopes),
      requestedOAuthScopes: requestedScopes,
      grantedOAuthScopes: grantedScopes,
      oauthScopeProfileVersion: CLOUDFLARE_OAUTH_SCOPE_PROFILE_VERSION,
      oauthScopeGrantStatus: cloudflareOAuthScopeGrantStatus(grantedScopes),
    };
  }
}

/**
 * The scope IDs Cloudflare actually granted. The provider reports them on the callback and in the
 * token response; when it reports neither, the grant is provable only because the broad optional
 * profile is empty - every configured scope is then required at the Cloudflare client, so a
 * completed exchange carries exactly the requested set. Never equate requested optional scopes
 * with granted ones.
 */
function resolveGrantedScopes(reported: string | undefined, requestedScopes: string[]): string[] {
  if (reported === undefined || reported.trim() === '') {
    if (BROAD_CLOUDFLARE_OAUTH_SCOPES.length > 0) {
      throw new CloudflareOAuthError('Cloudflare did not report which optional permissions were granted.');
    }
    return requestedScopes;
  }
  const parsed = parseReportedOAuthScopes(reported);
  if ('unknownScopes' in parsed) {
    throw new CloudflareOAuthError(
      `Cloudflare granted permissions CloudChef does not recognize: ${parsed.unknownScopes.join(', ')}.`,
    );
  }
  const missingCore = missingCoreOAuthScopes(parsed.granted);
  if (missingCore.length > 0) {
    throw new CloudflareOAuthError(
      `Cloudflare authorization is missing required permissions: ${missingCore.join(', ')}. Reconnect and approve every required permission.`,
    );
  }
  return parsed.granted;
}

function parseSession(value: string): OAuthSession {
  try {
    return oauthSessionSchema.parse(JSON.parse(value));
  } catch {
    throw new CloudflareOAuthError('Cloudflare OAuth session is invalid.');
  }
}

function randomBase64Url(bytes: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
