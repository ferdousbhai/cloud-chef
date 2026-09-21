import handler from '@tanstack/react-start/server-entry';
import { healthAction } from './server-handlers/health';
import { versionAction } from './server-handlers/version';

export { UserWorkspaceRuntimeProvisioningWorkflow } from './workflows/user-workspace-runtime-provisioning';
import {
  CLOUDFLARE_CONNECTION_CALLBACK_METHOD,
  cloudflareConnectionStatusAction,
  cloudflareRuntimeSessionAction,
  completeCloudflareConnectionAction,
  startCloudflareConnectionAction,
} from './server-handlers/cloudflare-integration';
import { authSessionAction, signOutAction } from './server-handlers/auth';
import { deleteAccountAction } from './server-handlers/account-deletion';
import { exportAccountAction } from './server-handlers/account-export';
import { runtimeCredentialAction } from './server-handlers/runtime-credential';
import { clientTelemetryAction } from './server-handlers/client-telemetry';
import { pruneCloudflareAuthDataBestEffort } from './lib/cloudflare/data/cloudflare-auth-retention.server';
import { CSP_NONCE_REQUEST_HEADER } from './lib/csp-nonce';

const APPLICATION_CSP_BASELINE = "base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'";
const HSTS_MIN_AGE_SECONDS = '31536000';
const PRODUCTION_HOSTNAME = 'cloudchef.build';
/**
 * Hostnames the product answered on before it was renamed. They stay attached to this Worker for
 * one reason: so the links, bookmarks, and search results that still point at them land on the
 * canonical origin instead of failing to resolve.
 */
const RETIRED_HOSTNAMES = new Set(['ghostbuild.dev', 'www.ghostbuild.dev']);

function methodNotAllowed(allowedMethod: string) {
  return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: allowedMethod } });
}

function requireMethod(request: Request, method: string, handler: () => Response | Promise<Response>) {
  return request.method === method ? handler() : methodNotAllowed(method);
}

function applyContentSecurityPolicyBaseline(headers: Headers, nonce?: string) {
  const applicationPolicy = nonce
    ? [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "connect-src 'self' https://*.workers.dev wss://*.workers.dev",
        'frame-src https:',
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        APPLICATION_CSP_BASELINE,
      ].join('; ')
    : APPLICATION_CSP_BASELINE;
  const current = headers.get('Content-Security-Policy');
  if (!current) {
    headers.set('Content-Security-Policy', applicationPolicy);
  } else if (!current.split(',').some((policy) => policy.trim() === applicationPolicy)) {
    // A CSP list enforces every policy independently. Appending keeps a
    // response's stricter resource policy while making this baseline mandatory.
    headers.append('Content-Security-Policy', applicationPolicy);
  }
}

function applyHstsFloor(headers: Headers) {
  const current = headers.get('Strict-Transport-Security');
  const directives = current?.split(';').map((directive) => directive.trim()) ?? [];
  const maxAgeDirectives = directives.filter((directive) => /^max-age(?:\s*=|$)/i.test(directive));
  const maxAge =
    maxAgeDirectives.length === 1 && maxAgeDirectives[0].length <= 64
      ? /^max-age\s*=\s*(\d{1,20})$/i.exec(maxAgeDirectives[0])?.[1]
      : undefined;
  const normalizedMaxAge = maxAge?.replace(/^0+(?=\d)/, '');
  const meetsFloor =
    normalizedMaxAge !== undefined &&
    (normalizedMaxAge.length > HSTS_MIN_AGE_SECONDS.length ||
      (normalizedMaxAge.length === HSTS_MIN_AGE_SECONDS.length && normalizedMaxAge >= HSTS_MIN_AGE_SECONDS));
  if (current && maxAgeDirectives.length === 1 && meetsFloor) {
    return;
  }
  const retainedDirectives = directives.filter((directive) => directive && !/^max-age(?:\s*=|$)/i.test(directive));
  headers.set('Strict-Transport-Security', [`max-age=${HSTS_MIN_AGE_SECONDS}`, ...retainedDirectives].join('; '));
}

function withApplicationSecurityHeaders(response: Response, pathname: string, nonce?: string) {
  const headers = new Headers(response.headers);
  const isHtml = headers.get('Content-Type')?.toLowerCase().includes('text/html') ?? false;
  applyContentSecurityPolicyBaseline(headers, isHtml ? nonce : undefined);
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  applyHstsFloor(headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  if (pathname === '/connect/return') {
    headers.set('Cache-Control', 'no-store');
    headers.set('Pragma', 'no-cache');
  } else if (isHtml) {
    // A cached document can reference hashed assets from a deployment that is
    // no longer current. Always revalidate navigations while immutable assets
    // remain cacheable by their content hash.
    headers.set('Cache-Control', 'no-store');
  } else if (pathname.startsWith('/api/') && !headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-store');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type ServerRoute = {
  method: 'GET' | 'POST';
  handler: (request: Request, env: Env) => Response | Promise<Response>;
};

const exactRoutes = new Map<string, ServerRoute>(
  Object.entries({
    '/api/health': {
      method: 'GET',
      handler: () => healthAction(),
    },
    '/api/client-telemetry': {
      method: 'POST',
      handler: (request, env) => clientTelemetryAction({ request, env }),
    },
    '/api/auth/session': {
      method: 'GET',
      handler: (request, env) => authSessionAction({ request, env }),
    },
    '/api/auth/sign-out': {
      method: 'POST',
      handler: (request, env) => signOutAction({ request, env }),
    },
    '/api/account/delete': {
      method: 'POST',
      handler: (request, env) => deleteAccountAction({ request, env }),
    },
    '/api/account/export': {
      method: 'POST',
      handler: (request, env) => exportAccountAction({ request, env }),
    },
    '/api/cloudflare/connection': {
      method: 'GET',
      handler: (request, env) => cloudflareConnectionStatusAction({ request, env }),
    },
    '/api/cloudflare/connection/start': {
      method: 'POST',
      handler: (request, env) => startCloudflareConnectionAction({ request, env }),
    },
    '/api/cloudflare/runtime-session': {
      method: 'POST',
      handler: (request, env) => cloudflareRuntimeSessionAction({ request, env }),
    },
    '/api/cloudflare/runtime-credential': {
      method: 'POST',
      handler: (request, env) => runtimeCredentialAction({ request, env }),
    },
    '/connect/return': {
      method: CLOUDFLARE_CONNECTION_CALLBACK_METHOD,
      handler: (request, env) => completeCloudflareConnectionAction({ request, env }),
    },
    '/api/version': {
      method: 'GET',
      handler: (_request, env) => versionAction({ env }),
    },
  }),
);

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const servedHostname =
      url.hostname === PRODUCTION_HOSTNAME ||
      url.hostname === `www.${PRODUCTION_HOSTNAME}` ||
      RETIRED_HOSTNAMES.has(url.hostname);
    if (servedHostname && (url.protocol !== 'https:' || url.hostname !== PRODUCTION_HOSTNAME)) {
      url.protocol = 'https:';
      url.hostname = PRODUCTION_HOSTNAME;
      return withApplicationSecurityHeaders(Response.redirect(url, 308), url.pathname);
    }
    const pathname = url.pathname;
    const nonce = crypto.randomUUID();
    return withApplicationSecurityHeaders(
      await routeApplicationRequest(request, env, nonce, pathname),
      pathname,
      nonce,
    );
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(pruneCloudflareAuthDataBestEffort(env.DB));
  },
} satisfies ExportedHandler<Env>;

async function routeApplicationRequest(request: Request, env: Env, nonce: string, pathname: string): Promise<Response> {
  const route = exactRoutes.get(pathname);
  if (route) {
    return requireMethod(request, route.method, () => route.handler(request, env));
  }

  const headers = new Headers(request.headers);
  headers.set(CSP_NONCE_REQUEST_HEADER, nonce);
  return handler.fetch(new Request(request, { headers }));
}
