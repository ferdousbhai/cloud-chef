import { z } from 'zod';
import { hostnameAndParents } from '~/lib/space-domains';

/**
 * Cloudflare's API for the domains of spaces CloudChef runs, called with a token of the operator's own account
 * (`MANAGED_DOMAINS_API_TOKEN`), never with a connection's authorization: custom hostnames and Worker routes on
 * CloudChef's own zone (`MANAGED_DOMAINS_ZONE_ID`) for a domain someone bought elsewhere and points here with a
 * CNAME to `MANAGED_DOMAINS_CNAME_TARGET`. The token reaches every zone of the account, so each call here names
 * CloudChef's zone itself and only ever touches the one hostname asked for.
 */
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 20_000;

export type ManagedDomainsConfig = { token: string; zoneId: string; cnameTarget: string };

/** What domains need, or null when any of it is unset: they are then not offered. */
export function managedDomainsConfig(env: Env): ManagedDomainsConfig | null {
  // SAFETY: the token is a secret the config declares only once domains are turned on (cloudflare.config.ts).
  const token = (env as Env & { MANAGED_DOMAINS_API_TOKEN?: string }).MANAGED_DOMAINS_API_TOKEN?.trim();
  const zoneId = env.MANAGED_DOMAINS_ZONE_ID?.trim();
  const cnameTarget = env.MANAGED_DOMAINS_CNAME_TARGET?.trim();
  return token && zoneId && cnameTarget ? { token, zoneId, cnameTarget } : null;
}

/** Cloudflare refused, or could not be reached; `status` is its HTTP status, 0 when there was no answer. */
export class ManagedDomainsError extends Error {
  constructor(
    readonly status: number,
    readonly codes: readonly number[],
  ) {
    super('Cloudflare did not accept the request.');
  }
}

const envelope = <T extends z.ZodType>(result: T) =>
  z.looseObject({
    success: z.boolean(),
    errors: z.array(z.looseObject({ code: z.number().optional() })).optional(),
    result: result.nullable().optional(),
  });

/** What these calls send: a custom hostname to make, or a Worker route. */
type RequestBody = { hostname: string; ssl: { method: 'http'; type: 'dv' } } | { pattern: string; script: string };

async function cloudflare<T>(
  config: ManagedDomainsConfig,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  schema: z.ZodType<T>,
  body?: RequestBody,
): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : null),
      },
      ...(body ? { body: JSON.stringify(body) } : null),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ManagedDomainsError(0, []);
  }
  const payload: unknown = await response.json().catch(() => null);
  const parsed = envelope(schema).safeParse(payload);
  if (!response.ok || !parsed.success || !parsed.data.success) {
    const codes =
      envelope(z.unknown())
        .safeParse(payload)
        .data?.errors?.flatMap((error) => error.code ?? []) ?? [];
    // Cloudflare's message can name the hostname; only the status and its codes are logged.
    console.error({ event: 'managed_domains_request_failed', method, status: response.status, codes });
    throw new ManagedDomainsError(response.status, codes);
  }
  return parsed.data.result ?? null;
}

/**
 * Whether the hostname is in, or under, a zone of the operator's own account: such a name is the operator's,
 * and is never given to a space however it is asked for.
 */
export async function hostnameIsInOwnAccount(config: ManagedDomainsConfig, hostname: string): Promise<boolean> {
  for (const name of hostnameAndParents(hostname)) {
    const zones = await cloudflare(
      config,
      'GET',
      `/zones?name=${encodeURIComponent(name)}`,
      z.array(z.looseObject({ id: z.string() })),
    );
    if ((zones?.length ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

const customHostnameSchema = z.looseObject({
  id: z.string().min(1),
  hostname: z.string(),
  status: z.string().optional(),
  ssl: z.looseObject({ status: z.string().optional() }).nullable().optional(),
});

/** A custom hostname as Cloudflare has it: whether its DNS points here yet, and whether its certificate is issued. */
export type CustomHostname = { id: string; pointsHere: boolean; certificateIssued: boolean };

function customHostnameFrom(raw: z.infer<typeof customHostnameSchema>): CustomHostname {
  return { id: raw.id, pointsHere: raw.status === 'active', certificateIssued: raw.ssl?.status === 'active' };
}

export async function readCustomHostname(
  config: ManagedDomainsConfig,
  hostname: string,
): Promise<CustomHostname | null> {
  const found = await cloudflare(
    config,
    'GET',
    `/zones/${config.zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
    z.array(customHostnameSchema),
  );
  const exact = found?.find((candidate) => candidate.hostname.toLowerCase() === hostname);
  return exact ? customHostnameFrom(exact) : null;
}

/** Asks Cloudflare to serve the hostname on CloudChef's zone, with a certificate it validates over HTTP. */
export async function createCustomHostname(config: ManagedDomainsConfig, hostname: string): Promise<CustomHostname> {
  const existing = await readCustomHostname(config, hostname);
  if (existing) {
    return existing;
  }
  const created = await cloudflare(config, 'POST', `/zones/${config.zoneId}/custom_hostnames`, customHostnameSchema, {
    hostname,
    ssl: { method: 'http', type: 'dv' },
  });
  if (!created) {
    throw new ManagedDomainsError(502, []);
  }
  return customHostnameFrom(created);
}

export async function deleteCustomHostname(config: ManagedDomainsConfig, hostname: string): Promise<void> {
  const existing = await readCustomHostname(config, hostname);
  if (existing) {
    await cloudflare(config, 'DELETE', `/zones/${config.zoneId}/custom_hostnames/${existing.id}`, z.unknown());
  }
}

const routeSchema = z.looseObject({ id: z.string().min(1), pattern: z.string(), script: z.string().optional() });

async function findRoute(config: ManagedDomainsConfig, hostname: string) {
  const routes = await cloudflare(config, 'GET', `/zones/${config.zoneId}/workers/routes`, z.array(routeSchema));
  return routes?.find((route) => route.pattern === routePattern(hostname)) ?? null;
}

function routePattern(hostname: string): string {
  return `${hostname}/*`;
}

/** Sends everything asked of the hostname to the Worker `script`, replacing where it went before. */
export async function routeHostnameToWorker(
  config: ManagedDomainsConfig,
  hostname: string,
  script: string,
): Promise<void> {
  const existing = await findRoute(config, hostname);
  const route = { pattern: routePattern(hostname), script };
  if (!existing) {
    await cloudflare(config, 'POST', `/zones/${config.zoneId}/workers/routes`, z.unknown(), route);
  } else if (existing.script !== script) {
    await cloudflare(config, 'PUT', `/zones/${config.zoneId}/workers/routes/${existing.id}`, z.unknown(), route);
  }
}

export async function deleteHostnameRoute(config: ManagedDomainsConfig, hostname: string): Promise<void> {
  const existing = await findRoute(config, hostname);
  if (existing) {
    await cloudflare(config, 'DELETE', `/zones/${config.zoneId}/workers/routes/${existing.id}`, z.unknown());
  }
}
