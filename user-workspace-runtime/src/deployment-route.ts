const DEPLOYMENT_PATH = /^\/v1\/deployments\/([^/]+)(?:\/(deploy))?$/;

type DeploymentRoute =
  | { deploymentId: string; operation: 'get' | 'deploy' }
  /** The path names a deployment route, but not for this method; answer 405 with this `Allow`. */
  | { allow: string };

/**
 * The browser's deployment routes: `GET` reads a deployment, and only `POST` starts one. A capability
 * may ride in the query string and a top-level navigation sends no `Origin`, so a link or redirect
 * (always a `GET`) must never be able to deploy.
 */
export function matchDeploymentRoute(method: string, pathname: string): DeploymentRoute | null {
  const match = DEPLOYMENT_PATH.exec(pathname);
  if (!match) {
    return null;
  }
  const operation = match[2] === 'deploy' ? 'deploy' : 'get';
  const allowed = operation === 'deploy' ? 'POST' : 'GET';
  if (method !== allowed) {
    return { allow: allowed };
  }
  return { deploymentId: decodeURIComponent(match[1]!), operation };
}
