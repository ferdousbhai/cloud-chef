/**
 * The checked-in Cloudflare OAuth scope manifest.
 *
 * Production requests exactly these reviewed scopes; nothing composes a scope string from a live
 * catalog during login. Every one is required: a grant missing any is refused when it completes, and a
 * connection missing one added since it was authorized is asked to reauthorize before it is used.
 * Every scope here is checked against the reviewed capture of GET /oauth/scopes beside this file.
 */
export const CORE_CLOUDFLARE_OAUTH_SCOPES = [
  'account-settings.read',
  'user-details.read',
  'workers-scripts.write',
  'containers.write',
  'd1.write',
  'workers-r2.write',
  'workers-kv-storage.write',
  'ai.read',
  // Linking an account's own Anthropic key to its AI Gateway (BYOK), from Settings: the gateway's
  // provider keys, and the Secrets Store secrets they are kept in.
  'aig.write',
  'secrets-store.write',
] as const;

/**
 * Normalize a provider-reported scope string. `offline_access` is the refresh-token grant, not a
 * resource permission, so it never reaches the stored grant.
 */
export function parseReportedOAuthScopes(reported: string): { granted: string[] } | { unknownScopes: string[] } {
  const scopes = [...new Set(reported.split(/\s+/).filter(Boolean))].filter((scope) => scope !== 'offline_access');
  const known = new Set<string>(CORE_CLOUDFLARE_OAUTH_SCOPES);
  const unknownScopes = scopes.filter((scope) => !known.has(scope));
  return unknownScopes.length > 0 ? { unknownScopes } : { granted: scopes };
}

export function missingCoreOAuthScopes(granted: readonly string[]): string[] {
  const held = new Set(granted);
  return CORE_CLOUDFLARE_OAUTH_SCOPES.filter((scope) => !held.has(scope));
}
