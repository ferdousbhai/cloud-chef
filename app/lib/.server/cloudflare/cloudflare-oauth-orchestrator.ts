import { z } from 'zod';
import { bytesToBase64Url } from '~/lib/hex-digest';
import {
  CORE_CLOUDFLARE_OAUTH_SCOPES,
  missingCoreOAuthScopes,
  parseReportedOAuthScopes,
} from './cloudflare-oauth-scope-manifest';

const AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';
const TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const USER_DETAILS_URL = 'https://api.cloudflare.com/client/v4/user';
const ACCOUNTS_URL = 'https://api.cloudflare.com/client/v4/accounts?per_page=2';
const SESSION_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

type CloudflareConnectionChallenge = {
  sessionId: string;
  authorizationUrl: string;
  expiresAt: number;
};

export type CloudflareConnectionResult = {
  user: {
    subject: string;
    email: string | null;
    name: string | null;
    picture: string | null;
  };
  accountId: string;
  accountName: string | null;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  /** Exact provider-confirmed scope IDs, every core scope among them. */
  grantedOAuthScopes: string[];
};

export class CloudflareOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareOAuthError';
  }
}

export class CloudflareOAuthUnavailableError extends Error {
  constructor() {
    super('Cloudflare account provisioning is not configured for this environment.');
    this.name = 'CloudflareOAuthUnavailableError';
  }
}

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

/** Cloudflare's OAuth authorization of CloudChef, requesting exactly the manifest's scopes. */
export class CloudflareOAuthOrchestrator {
  constructor(private readonly config: { clientId: string; clientSecret: string }) {}

  /** The configured client, or CloudflareOAuthUnavailableError when this environment has none. */
  static fromEnv(env: Env): CloudflareOAuthOrchestrator {
    if (!env.CLOUDFLARE_OAUTH_CLIENT_ID || !env.CLOUDFLARE_OAUTH_CLIENT_SECRET) {
      throw new CloudflareOAuthUnavailableError();
    }
    return new CloudflareOAuthOrchestrator({
      clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
      clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    });
  }

  async startConnection(request: { returnUrl: string }): Promise<CloudflareConnectionChallenge> {
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
    authorizationUrl.searchParams.set('scope', [...CORE_CLOUDFLARE_OAUTH_SCOPES, 'offline_access'].join(' '));
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

  async completeConnection(request: {
    providerSessionId: string;
    callbackUrl: string;
  }): Promise<CloudflareConnectionResult> {
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
    const tokenResponse = await fetch(TOKEN_URL, {
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
    const grantedScopes = resolveGrantedScopes(token.scope ?? callback.searchParams.get('scope') ?? undefined);
    const userDetailsResponse = await fetch(USER_DETAILS_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    });
    const userDetailsPayload = userDetailsSchema.safeParse(await userDetailsResponse.json().catch(() => null)).data;
    const userDetails = userDetailsPayload?.result;
    if (!userDetailsResponse.ok || userDetailsPayload?.success !== true || !userDetails?.id) {
      throw new CloudflareOAuthError('Cloudflare did not return an authenticated user identity.');
    }
    const accountsResponse = await fetch(ACCOUNTS_URL, {
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
      // A token without a reported lifetime is treated as already due, so its first use refreshes it.
      accessTokenExpiresAt: Date.now() + Math.max(0, token.expires_in ?? 0) * 1_000,
      grantedOAuthScopes: grantedScopes,
    };
  }
}

/**
 * The scope IDs Cloudflare actually granted. The provider reports them on the callback and in the
 * token response; when it reports neither, every requested scope is required at the Cloudflare
 * client, so a completed exchange carries exactly the manifest's.
 */
function resolveGrantedScopes(reported: string | undefined): string[] {
  if (reported === undefined || reported.trim() === '') {
    return [...CORE_CLOUDFLARE_OAUTH_SCOPES];
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
