import { z } from 'zod';
import { hostnameAndParents } from '~/lib/space-domains';

/**
 * Cloudflare's API for the domains of spaces CloudChef runs, called with a token of the operator's own account
 * (`MANAGED_DOMAINS_API_TOKEN`), never with a connection's authorization: custom hostnames and Worker routes on
 * CloudChef's own zone (`MANAGED_DOMAINS_ZONE_ID`) for a domain someone bought elsewhere and points here with a
 * CNAME to `MANAGED_DOMAINS_CNAME_TARGET`; and, for a domain bought through CloudChef, its registration in that
 * account (`MANAGED_DOMAINS_ACCOUNT_ID`) in the buyer's name and its attachment to the project's Worker. The token
 * reaches every zone of the account, so each call here names CloudChef's zone, or the one domain just registered,
 * and only ever touches the one hostname asked for.
 */
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 20_000;

export type ManagedDomainsConfig = {
  token: string;
  zoneId: string;
  cnameTarget: string;
  /** The operator's account, where bought domains are registered; null where buying is not set up. */
  accountId: string | null;
};

/** What domains need, or null when any of it is unset: they are then not offered. */
export function managedDomainsConfig(env: Env): ManagedDomainsConfig | null {
  // SAFETY: the token is a secret the config declares only once domains are turned on (cloudflare.config.ts).
  const token = (env as Env & { MANAGED_DOMAINS_API_TOKEN?: string }).MANAGED_DOMAINS_API_TOKEN?.trim();
  const zoneId = env.MANAGED_DOMAINS_ZONE_ID?.trim();
  const cnameTarget = env.MANAGED_DOMAINS_CNAME_TARGET?.trim();
  return token && zoneId && cnameTarget
    ? { token, zoneId, cnameTarget, accountId: env.MANAGED_DOMAINS_ACCOUNT_ID?.trim() || null }
    : null;
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

/** What these calls send: a custom hostname to make, a Worker route, or a registration and what follows it. */
type RequestBody =
  | { hostname: string; ssl: { method: 'http'; type: 'dv' } }
  | { pattern: string; script: string }
  | { domains: string[] }
  | { domain_name: string; auto_renew: boolean; contacts: { registrant: RegistrantContact } }
  | { auto_renew: boolean }
  | { hostname: string; service: string; zone_id: string };

async function cloudflare<T>(
  config: ManagedDomainsConfig,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

/**
 * Who a bought domain is registered to, as the registry takes it: the buyer, from the billing details they gave
 * Stripe. The phone is `+<country code>.<number>`.
 */
export type RegistrantContact = {
  email: string;
  phone: string;
  postal_info: {
    name: string;
    address: { street: string; city: string; state: string; postal_code: string; country_code: string };
  };
};

const offerSchema = z.looseObject({
  name: z.string(),
  registrable: z.boolean(),
  tier: z.string().optional(),
  pricing: z
    .looseObject({ currency: z.string(), registration_cost: z.string(), renewal_cost: z.string() })
    .nullable()
    .optional(),
});
const offersSchema = z.looseObject({ domains: z.array(offerSchema) });

/** A domain that can be registered now, and what a year of it costs the operator, in cents. */
export type DomainOffer = { name: string; yearlyCostCents: number };

/**
 * An offer only for a name anyone may register at its registry's standard price in dollars: premium names, whose
 * price is the registry's to set each year, are left out. A year costs the dearer of registering and renewing,
 * since the buyer pays the same every year.
 */
function offerFrom(raw: z.infer<typeof offerSchema>): DomainOffer | null {
  const pricing = raw.pricing;
  if (!raw.registrable || raw.tier !== 'standard' || pricing?.currency !== 'USD') {
    return null;
  }
  const cents = Math.round(Math.max(Number(pricing.registration_cost), Number(pricing.renewal_cost)) * 100);
  return Number.isFinite(cents) && cents > 0 ? { name: raw.name.toLowerCase(), yearlyCostCents: cents } : null;
}

function registrarPath(config: ManagedDomainsConfig): string {
  if (!config.accountId) {
    throw new ManagedDomainsError(0, []);
  }
  return `/accounts/${config.accountId}/registrar`;
}

/** Names like `query` that can be registered, from Cloudflare's cached search: for choosing, not for buying. */
export async function searchDomainOffers(config: ManagedDomainsConfig, query: string): Promise<DomainOffer[]> {
  const found = await cloudflare(
    config,
    'GET',
    `${registrarPath(config)}/domain-search?q=${encodeURIComponent(query)}&limit=10`,
    offersSchema,
  );
  return (found?.domains ?? []).flatMap((offer) => offerFrom(offer) ?? []);
}

/** Whether the name can be registered right now, asked of its registry, and at what cost; null when it can't. */
export async function checkDomainOffer(config: ManagedDomainsConfig, name: string): Promise<DomainOffer | null> {
  const checked = await cloudflare(config, 'POST', `${registrarPath(config)}/domain-check`, offersSchema, {
    domains: [name],
  });
  const offer = checked?.domains.find((candidate) => candidate.name.toLowerCase() === name);
  return offer ? offerFrom(offer) : null;
}

const registrationSchema = z.looseObject({
  state: z.string(),
  context: z
    .looseObject({ registration: z.looseObject({ expires_at: z.string().optional() }).optional() })
    .nullable()
    .optional(),
});

/** Where a registration stands: done, with when it runs to; still going; or stopped for good. */
export type RegistrationState = { state: 'registered'; expiresAt: number | null } | { state: 'pending' | 'failed' };

function registrationFrom(raw: z.infer<typeof registrationSchema> | null): RegistrationState {
  if (raw?.state === 'succeeded') {
    const expires = Date.parse(raw.context?.registration?.expires_at ?? '');
    return { state: 'registered', expiresAt: Number.isFinite(expires) ? expires : null };
  }
  return { state: raw?.state === 'in_progress' ? 'pending' : 'failed' };
}

/**
 * Registers the name to `registrant` in the operator's account, renewing by itself each year. Cloudflare charges
 * the account's payment method, and a registration that completes is not refunded: callers confirm the name
 * and its price first.
 */
export async function registerDomain(
  config: ManagedDomainsConfig,
  name: string,
  registrant: RegistrantContact,
): Promise<RegistrationState> {
  return registrationFrom(
    await cloudflare(config, 'POST', `${registrarPath(config)}/registrations`, registrationSchema, {
      domain_name: name,
      auto_renew: true,
      contacts: { registrant },
    }),
  );
}

/** Where the registration of `name` stands now; `failed` too when there is none. */
export async function readRegistration(config: ManagedDomainsConfig, name: string): Promise<RegistrationState> {
  try {
    return registrationFrom(
      await cloudflare(
        config,
        'GET',
        `${registrarPath(config)}/registrations/${encodeURIComponent(name)}/registration-status`,
        registrationSchema,
      ),
    );
  } catch (error) {
    if (error instanceof ManagedDomainsError && error.status === 404) {
      return { state: 'failed' };
    }
    throw error;
  }
}

/** Whether Cloudflare renews the registration each year, charging the operator: on only while the buyer pays. */
export async function setDomainAutoRenew(config: ManagedDomainsConfig, name: string, renews: boolean): Promise<void> {
  await cloudflare(config, 'PATCH', `${registrarPath(config)}/registrations/${encodeURIComponent(name)}`, z.unknown(), {
    auto_renew: renews,
  });
}

/**
 * Serves a registered domain, and its `www`, from the Worker `service`: the domain is a zone of the operator's
 * account, so it is attached to the Worker itself. False while the zone is not there yet.
 */
export async function attachDomainToWorker(
  config: ManagedDomainsConfig,
  name: string,
  service: string,
): Promise<boolean> {
  if (!config.accountId) {
    throw new ManagedDomainsError(0, []);
  }
  const zones = await cloudflare(
    config,
    'GET',
    `/zones?name=${encodeURIComponent(name)}`,
    z.array(z.looseObject({ id: z.string().min(1) })),
  );
  const zoneId = zones?.[0]?.id;
  if (!zoneId) {
    return false;
  }
  for (const hostname of [name, `www.${name}`]) {
    await cloudflare(config, 'PUT', `/accounts/${config.accountId}/workers/domains`, z.unknown(), {
      hostname,
      service,
      zone_id: zoneId,
    });
  }
  return true;
}
