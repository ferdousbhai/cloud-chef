/**
 * What CloudChef's own Wrangler may ask Cloudflare's API while it deploys a project CloudChef deploys itself, through
 * the deploy proxy that adds the account's authorization. It is what deploying one Worker takes, and no more: reading
 * the account's Workers, D1 databases, KV namespaces and R2 buckets; writing that one Worker; making the D1, KV and R2
 * resources its config asks for; and applying D1 migrations. Nothing is ever deleted, and no other Worker is written.
 */

type DeployApiRequest = { method: string; path: string };

/** How a request is sent on: with the account's token, as it came (asset uploads carry their own), or not at all. */
type DeployApiDecision = 'with_token' | 'as_sent' | 'refused';

const READ_METHODS = new Set(['GET', 'HEAD']);
const WRITE_METHODS = new Set(['PUT', 'POST', 'PATCH']);

/**
 * The decision for one request of a deploy of `workerName` in `accountId`. Paths are the API's own, below
 * `/client/v4`.
 */
export function deployApiDecision(
  request: DeployApiRequest,
  context: { accountId: string; workerName: string },
): DeployApiDecision {
  const method = request.method.toUpperCase();
  const path = request.path.replace(/\/+$/, '');
  const account = `/accounts/${context.accountId}`;
  if (method === 'DELETE' || (!READ_METHODS.has(method) && !WRITE_METHODS.has(method))) {
    return 'refused';
  }
  // Wrangler reads who it is and the account it deploys to.
  if (READ_METHODS.has(method) && (path === '/user' || path === '/memberships' || path === account)) {
    return 'with_token';
  }
  if (!path.startsWith(`${account}/`)) {
    return 'refused';
  }
  const rest = path.slice(account.length);
  // Static assets go up with the upload session's own JWT, which Wrangler sends itself.
  if (method === 'POST' && rest === '/workers/assets/upload') {
    return 'as_sent';
  }
  if (READ_METHODS.has(method)) {
    return /^\/(workers|d1\/database|storage\/kv\/namespaces|r2\/buckets)(\/|$)/.test(rest) &&
      !/^\/storage\/kv\/namespaces\/[^/]+\/(values|keys)/.test(rest)
      ? 'with_token'
      : 'refused';
  }
  const worker = `/workers/scripts/${context.workerName}`;
  const services = `/workers/services/${context.workerName}`;
  if (rest === worker || rest.startsWith(`${worker}/`) || rest === services || rest.startsWith(`${services}/`)) {
    return 'with_token';
  }
  // Resources the config asks for, made the first time; and migrations applied to its databases.
  if (
    method === 'POST' &&
    (rest === '/d1/database' ||
      rest === '/storage/kv/namespaces' ||
      rest === '/r2/buckets' ||
      /^\/d1\/database\/[0-9a-f-]{36}\/(query|raw)$/.test(rest))
  ) {
    return 'with_token';
  }
  return 'refused';
}
