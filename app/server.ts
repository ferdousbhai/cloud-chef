import handler from '@tanstack/react-start/server-entry';
import { healthAction } from './server-handlers/health';
import { versionAction } from './server-handlers/version';

export { UserWorkspaceRuntimeProvisioningWorkflow } from './workflows/user-workspace-runtime-provisioning';
import {
  cloudflareConnectionStatusAction,
  cloudflareRuntimeSessionAction,
  completeCloudflareConnectionAction,
  startCloudflareConnectionAction,
} from './server-handlers/cloudflare-integration';
import { authSessionAction, signOutAction } from './server-handlers/auth';
import {
  completeEmailSignInAction,
  describeEmailSignInAction,
  startEmailSignInAction,
} from './server-handlers/email-auth';
import {
  acceptInviteAction,
  describeInviteAction,
  createOrganizationAction,
  inviteToOrganizationAction,
  listOrganizationsAction,
  revokeInviteAction,
  renameOrganizationAction,
  deleteOrganizationAction,
  switchContextAction,
  updateMemberAction,
} from './server-handlers/organizations';
import { completeGoogleSignInAction, GOOGLE_RETURN_PATH, startGoogleSignInAction } from './server-handlers/google-auth';
import {
  runtimeOpenProjectAction,
  runtimeAbandonImportAction,
  runtimeProjectImportedAction,
  runtimeRegisterImportAction,
  runtimeProjectSiteAction,
  runtimeProjectStatusAction,
  runtimeRequestProductionAction,
} from './server-handlers/runtime-projects';
import {
  completeGitHubInstallAction,
  disconnectGitHubAction,
  GITHUB_RETURN_PATH,
  listGitHubRepositoriesAction,
  startGitHubInstallAction,
} from './server-handlers/github-projects';
import {
  approveProductionRequestAction,
  declineProductionRequestAction,
  listMyProjectsAction,
  PROJECT_WORKERS_BUILDS_SWITCH_ROUTE,
  projectRoute,
  removeProjectAction,
  setProjectAccessAction,
  switchProjectWorkersBuildsAction,
} from './server-handlers/projects';
import { deleteAccountAction } from './server-handlers/account-deletion';
import { exportAccountAction } from './server-handlers/account-export';
import { aiGatewayLoggingAction, updateAiGatewayLoggingAction } from './server-handlers/ai-gateway-logging';
import {
  runtimeAccessAction,
  runtimeCredentialAction,
  runtimeModelsAction,
  runtimeUsageAction,
} from './server-handlers/runtime-credential';
import {
  linkGatewayKeyAction,
  modelSettingsAction,
  unlinkGatewayKeyAction,
  updateAllowedModelsAction,
  updateDefaultModelAction,
} from './server-handlers/model-settings';
import { clientTelemetryAction } from './server-handlers/client-telemetry';
import { pruneCloudflareAuthDataBestEffort } from './lib/cloudflare/data/cloudflare-auth-retention.server';
import { sweepUserWorkspaceRuntimeUpgradesBestEffort } from './lib/.server/cloudflare/user-workspace-runtime-upgrade-sweep';
import { CSP_NONCE_REQUEST_HEADER } from './lib/csp-nonce';
import { sha256Hex } from './lib/hex-digest';

const APPLICATION_CSP_BASELINE = "base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'";
const HSTS_MAX_AGE_SECONDS = 31_536_000;
const PRODUCTION_HOSTNAME = 'cloudchef.build';

function applyContentSecurityPolicy(headers: Headers, nonce?: string) {
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
  headers.set('Content-Security-Policy', applicationPolicy);
}

function withApplicationSecurityHeaders(response: Response, pathname: string, nonce?: string) {
  const headers = new Headers(response.headers);
  const isHtml = headers.get('Content-Type')?.toLowerCase().includes('text/html') ?? false;
  applyContentSecurityPolicy(headers, isHtml ? nonce : undefined);
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_SECONDS}`);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  if (pathname === '/connect/return' || pathname === GOOGLE_RETURN_PATH || pathname === GITHUB_RETURN_PATH) {
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

type RouteHandler = (args: { request: Request; env: Env }) => Response | Promise<Response>;

/** Each exact path's one method and its handler. */
const exactRoutes = new Map<string, readonly ['GET' | 'POST', RouteHandler]>(
  Object.entries({
    '/api/health': ['GET', healthAction],
    '/api/client-telemetry': ['POST', clientTelemetryAction],
    '/api/auth/session': ['GET', authSessionAction],
    '/api/auth/sign-out': ['POST', signOutAction],
    '/api/auth/email/start': ['POST', startEmailSignInAction],
    '/api/auth/email/describe': ['POST', describeEmailSignInAction],
    '/api/auth/email/complete': ['POST', completeEmailSignInAction],
    '/api/auth/google/start': ['POST', startGoogleSignInAction],
    '/api/organizations/github/start': ['POST', startGitHubInstallAction],
    '/api/organizations/github/disconnect': ['POST', disconnectGitHubAction],
    '/api/organizations/github/repositories': ['GET', listGitHubRepositoriesAction],
    '/api/organizations/production-requests/approve': ['POST', approveProductionRequestAction],
    '/api/organizations/production-requests/decline': ['POST', declineProductionRequestAction],
    '/api/organizations/projects/access': ['POST', setProjectAccessAction],
    '/api/organizations/projects/unlink': ['POST', removeProjectAction],
    [PROJECT_WORKERS_BUILDS_SWITCH_ROUTE]: ['POST', switchProjectWorkersBuildsAction],
    '/api/cloudflare/runtime-projects/open': ['POST', runtimeOpenProjectAction],
    '/api/cloudflare/runtime-projects/imported': ['POST', runtimeProjectImportedAction],
    '/api/cloudflare/runtime-projects/abandon-import': ['POST', runtimeAbandonImportAction],
    '/api/cloudflare/runtime-projects/register-import': ['POST', runtimeRegisterImportAction],
    '/api/cloudflare/runtime-projects/status': ['POST', runtimeProjectStatusAction],
    '/api/cloudflare/runtime-projects/site': ['POST', runtimeProjectSiteAction],
    '/api/cloudflare/runtime-projects/request-production': ['POST', runtimeRequestProductionAction],
    '/api/org-projects': ['GET', listMyProjectsAction],
    [GITHUB_RETURN_PATH]: ['GET', completeGitHubInstallAction],
    '/api/organizations': ['GET', listOrganizationsAction],
    '/api/organizations/invite/describe': ['POST', describeInviteAction],
    '/api/organizations/create': ['POST', createOrganizationAction],
    '/api/organizations/invite': ['POST', inviteToOrganizationAction],
    '/api/organizations/accept': ['POST', acceptInviteAction],
    '/api/organizations/member': ['POST', updateMemberAction],
    '/api/organizations/invite/revoke': ['POST', revokeInviteAction],
    '/api/organizations/rename': ['POST', renameOrganizationAction],
    '/api/organizations/delete': ['POST', deleteOrganizationAction],
    '/api/context': ['POST', switchContextAction],
    [GOOGLE_RETURN_PATH]: ['GET', completeGoogleSignInAction],
    '/api/account/delete': ['POST', deleteAccountAction],
    '/api/account/export': ['POST', exportAccountAction],
    '/api/settings/ai-gateway-logging': ['GET', aiGatewayLoggingAction],
    '/api/settings/ai-gateway-logging/update': ['POST', updateAiGatewayLoggingAction],
    '/api/settings/models': ['GET', modelSettingsAction],
    '/api/settings/models/default': ['POST', updateDefaultModelAction],
    '/api/settings/models/allowed': ['POST', updateAllowedModelsAction],
    '/api/settings/models/keys/link': ['POST', linkGatewayKeyAction],
    '/api/settings/models/keys/unlink': ['POST', unlinkGatewayKeyAction],
    '/api/cloudflare/connection': ['GET', cloudflareConnectionStatusAction],
    '/api/cloudflare/connection/start': ['POST', startCloudflareConnectionAction],
    '/api/cloudflare/runtime-session': ['POST', cloudflareRuntimeSessionAction],
    '/api/cloudflare/runtime-credential': ['POST', runtimeCredentialAction],
    '/api/cloudflare/runtime-access': ['POST', runtimeAccessAction],
    '/api/cloudflare/runtime-models': ['POST', runtimeModelsAction],
    '/api/cloudflare/runtime-usage': ['POST', runtimeUsageAction],
    '/connect/return': ['GET', completeCloudflareConnectionAction],
    '/api/version': ['GET', versionAction],
  }),
);

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const servedHostname = url.hostname === PRODUCTION_HOSTNAME || url.hostname === `www.${PRODUCTION_HOSTNAME}`;
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
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      Promise.all([
        pruneCloudflareAuthDataBestEffort(env.DB),
        sweepUserWorkspaceRuntimeUpgradesBestEffort(env, controller.scheduledTime),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;

/** The routes workspace runtimes call with their secret; runtime-session is the browser's. */
function isRuntimeRoute(pathname: string): boolean {
  return pathname.startsWith('/api/cloudflare/runtime-') && pathname !== '/api/cloudflare/runtime-session';
}

/**
 * Whether this caller has made too many runtime calls this minute. The key is a digest of its bearer
 * secret, not its address: every runtime's Worker reaches CloudChef from the same Cloudflare egress, and
 * a caller without a valid secret can't spend a real runtime's allowance.
 */
async function runtimeRateLimited(request: Request, env: Env): Promise<boolean> {
  const digest = await sha256Hex(request.headers.get('Authorization') ?? '');
  const { success } = await env.RUNTIME_RATE_LIMITER.limit({ key: `runtime:${digest.slice(0, 32)}` });
  return !success;
}

async function routeApplicationRequest(request: Request, env: Env, nonce: string, pathname: string): Promise<Response> {
  // A path naming one project is routed by its pattern; the handler reads the project from the path.
  const route = exactRoutes.get(projectRoute(pathname) ?? pathname);
  if (route) {
    const [method, routeHandler] = route;
    if (request.method !== method) {
      return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: method } });
    }
    try {
      return isRuntimeRoute(pathname) && (await runtimeRateLimited(request, env))
        ? Response.json(
            { error: 'Too many requests from this workspace. Try again shortly.' },
            { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } },
          )
        : await routeHandler({ request, env });
    } catch (error) {
      // A route that threw, such as on a passing D1 or GitHub failure, is answered here so the
      // error still gets the security headers rather than Cloudflare's own error page. No route
      // throws a Response on purpose. Only the route and the error are logged, never the request.
      console.error(
        'A route failed',
        pathname,
        error instanceof Error ? `${error.name}: ${error.message}` : 'not an Error',
      );
      return Response.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
    }
  }

  const headers = new Headers(request.headers);
  headers.set(CSP_NONCE_REQUEST_HEADER, nonce);
  return handler.fetch(new Request(request, { headers }));
}
