import { z } from 'zod';

/**
 * A domain of a person's own serving a project in a space CloudChef runs, as the browser and the server
 * speak of it (`app/server-handlers/space-domains.ts`).
 */
export const spaceDomainSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  kind: z.enum(['connected', 'bought']),
  status: z.enum(['pending', 'active', 'failed']),
  /** What is still waited for, in the person's words; null once the domain serves the project. */
  waitingFor: z.string().nullable(),
});
export type SpaceDomain = z.infer<typeof spaceDomainSchema>;

export const spaceDomainsSchema = z.object({
  /** False where domains are not set up, or the project is not in a space CloudChef runs. */
  available: z.boolean(),
  /** Where a connected domain's CNAME record points. */
  cnameTarget: z.string().nullable(),
  domains: z.array(spaceDomainSchema),
});
export type SpaceDomains = z.infer<typeof spaceDomainsSchema>;

/** Domains a space may have at once: each costs CloudChef a little every month. */
export const MAX_SPACE_DOMAINS = 5;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** Hostnames that are CloudChef's or Cloudflare's own, which nobody connects. */
const RESERVED_SUFFIXES = ['cloudchef.build', 'workers.dev', 'pages.dev', 'cloudflare.com', 'localhost'];

/**
 * A hostname as typed, made the one a DNS record names: lower case, without a scheme, path, port or trailing
 * dot. Null when it is not a public hostname someone could own (an address, a single label, one of
 * CloudChef's or Cloudflare's own).
 */
export function normalizeHostname(typed: string): string | null {
  const hostname = typed
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  const labels = hostname.split('.');
  if (hostname.length > 253 || labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return null;
  }
  // An address, or a name whose last label could not be a top-level domain.
  if (/^\d+$/.test(labels.at(-1) ?? '')) {
    return null;
  }
  if (RESERVED_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    return null;
  }
  return hostname;
}

/** The hostname and each of its parents that could be a registered domain, longest first. */
export function hostnameAndParents(hostname: string): string[] {
  const labels = hostname.split('.');
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'));
}
