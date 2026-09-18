/**
 * The checked-in Cloudflare OAuth scope manifest (docs/cloudflare-broad-oauth-mcp-plan.md).
 *
 * Production requests exactly this reviewed profile; nothing composes a scope string from a live
 * catalog during login. The broad optional profile stays empty until the Phase 0 provider
 * preflight (catalog fetch via GET /oauth/scopes, consent-mode checks, granted-scope reporting)
 * lands a reviewed catalog. While it is empty, every scope the Cloudflare OAuth client is
 * configured with is required, so a completed authorization proves the whole core grant.
 */
export const CLOUDFLARE_OAUTH_SCOPE_PROFILE_VERSION = 'core-v1';

export const CORE_CLOUDFLARE_OAUTH_SCOPES = [
  'account-settings.read',
  'user-details.read',
  'workers-scripts.write',
  'containers.write',
  'd1.write',
  'workers-r2.write',
  'workers-kv-storage.write',
  'ai.read',
] as const;

/** Reviewed broad optional scope IDs. Populated only by the Phase 0 preflight, never by hand. */
export const BROAD_CLOUDFLARE_OAUTH_SCOPES = [] satisfies readonly string[];

export type CloudflareOAuthScopeGrantStatus = 'unknown' | 'core' | 'partial' | 'full';

const CLOUDCHEF_CAPABILITIES = ['workers', 'containers', 'd1', 'r2', 'kv', 'durable_objects', 'workers_ai'] as const;

export type CloudChefCapability = (typeof CLOUDCHEF_CAPABILITIES)[number];

/** The scope IDs each CloudChef product capability needs before it can be considered granted. */
const CAPABILITY_SCOPE_REQUIREMENTS = {
  workers: ['workers-scripts.write'],
  containers: ['containers.write'],
  d1: ['d1.write'],
  r2: ['workers-r2.write'],
  kv: ['workers-kv-storage.write'],
  durable_objects: ['workers-scripts.write'],
  workers_ai: ['ai.read'],
} satisfies Record<CloudChefCapability, readonly string[]>;

/** Stable, deduplicated scope request order: core first, then the broad optional profile. */
export function requestedCloudflareOAuthScopes(): string[] {
  return [...new Set<string>([...CORE_CLOUDFLARE_OAUTH_SCOPES, ...BROAD_CLOUDFLARE_OAUTH_SCOPES])];
}

/**
 * Normalize a provider-reported scope string. `offline_access` is the refresh-token grant, not a
 * resource permission, so it never reaches the stored grant.
 */
export function parseReportedOAuthScopes(reported: string): { granted: string[] } | { unknownScopes: string[] } {
  const scopes = [...new Set(reported.split(/\s+/).filter(Boolean))].filter((scope) => scope !== 'offline_access');
  const known = new Set(requestedCloudflareOAuthScopes());
  const unknownScopes = scopes.filter((scope) => !known.has(scope));
  return unknownScopes.length > 0 ? { unknownScopes } : { granted: scopes };
}

export function missingCoreOAuthScopes(granted: readonly string[]): string[] {
  const held = new Set(granted);
  return CORE_CLOUDFLARE_OAUTH_SCOPES.filter((scope) => !held.has(scope));
}

/**
 * Grant state for a provider-confirmed scope list. 'full' exists only once the broad profile is
 * non-empty; until then a complete grant is exactly the core feature set.
 */
export function cloudflareOAuthScopeGrantStatus(granted: readonly string[]): CloudflareOAuthScopeGrantStatus {
  if (missingCoreOAuthScopes(granted).length > 0) {
    return 'unknown';
  }
  if (BROAD_CLOUDFLARE_OAUTH_SCOPES.length === 0) {
    return 'core';
  }
  const held = new Set(granted);
  return BROAD_CLOUDFLARE_OAUTH_SCOPES.every((scope) => held.has(scope)) ? 'full' : 'partial';
}

/** The product capabilities whose scope requirements the grant fully covers. */
export function capabilitiesFromOAuthScopes(granted: readonly string[]): CloudChefCapability[] {
  const held = new Set(granted);
  return CLOUDCHEF_CAPABILITIES.filter((capability) =>
    CAPABILITY_SCOPE_REQUIREMENTS[capability].every((scope) => held.has(scope)),
  );
}
