import { z } from 'zod';
import type { CloudflareApiRequest } from 'cloudchef-agent/cloudflare-api';
import { isCloudChefResourceName } from '~/lib/.server/cloudflare/deploy-api-policy';
import { CANONICAL_ORIGIN } from '~/lib/.server/public-origin';

/**
 * What a change to the account's domains does, said before it is approved: the agent's Cloudflare requests can
 * attach any hostname of any zone in the account to a Worker, so one that would take CloudChef's own hostname or
 * Workers is refused, and one that moves a hostname already serving visitors says so in plain words.
 */
type DomainReview = { refusal: string } | { warning: string | null };

/** A read of the account's API by its path below `/client/v4`; null when it fails or isn't JSON. */
export type DomainReviewRead = (path: string) => Promise<unknown>;

const CLOUDCHEF_HOST = new URL(CANONICAL_ORIGIN).hostname;
const OWN_REFUSAL = 'CloudChef’s own address and Workers can’t be changed from a chat.';

const customDomainSchema = z.looseObject({
  hostname: z.string(),
  service: z.string(),
  override_existing_dns_record: z.boolean().optional(),
});
const routeSchema = z.looseObject({ pattern: z.string(), script: z.string().optional() });
const listed = <T extends z.ZodType>(item: T) => z.looseObject({ result: z.array(item) });
const single = <T extends z.ZodType>(item: T) => z.looseObject({ result: item });

export async function reviewDomainChange(request: CloudflareApiRequest, read: DomainReviewRead): Promise<DomainReview> {
  const path = new URL(request.url).pathname.replace(/^\/client\/v4/, '').replace(/\/+$/, '');
  const domains = /^\/accounts\/[^/]+\/workers\/domains(\/[^/]+)?$/.exec(path);
  if (domains) {
    return domains[1] ? reviewDomainRemoval(path, read) : reviewDomainAttach(path, request.body, read);
  }
  if (
    /^\/zones\/[^/]+\/workers\/routes(\/[^/]+)?$/.test(path) ||
    /^\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/routes$/.test(path)
  ) {
    return reviewRoutes(path, request, read);
  }
  if (/^\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/domains/.test(path)) {
    return reviewWorkerDomains(path);
  }
  return { warning: null };
}

async function reviewDomainAttach(path: string, body: unknown, read: DomainReviewRead): Promise<DomainReview> {
  const domain = customDomainSchema.safeParse(body);
  if (!domain.success) {
    return { warning: null };
  }
  const { hostname, service } = domain.data;
  if (isOwn(hostname, service)) {
    return { refusal: OWN_REFUSAL };
  }
  const existing = listed(customDomainSchema).safeParse(await read(`${path}?hostname=${encodeURIComponent(hostname)}`));
  const current = existing.success ? existing.data.result.find((entry) => entry.hostname === hostname) : undefined;
  if (current && isOwn(current.hostname, current.service)) {
    return { refusal: OWN_REFUSAL };
  }
  if (current && current.service !== service) {
    return {
      warning: `${hostname} already shows the Worker ${current.service}. Approving moves it to ${service}, and ${current.service} stops getting its visitors.`,
    };
  }
  if (current) {
    return { warning: null };
  }
  if (domain.data.override_existing_dns_record) {
    return {
      warning: `This replaces ${hostname}’s DNS record: whatever that address shows now stops getting its visitors, and ${service} gets them instead.`,
    };
  }
  return {
    warning: `${hostname} will show the Worker ${service}. If the address already has a DNS record, Cloudflare refuses the change and nothing moves.`,
  };
}

async function reviewDomainRemoval(path: string, read: DomainReviewRead): Promise<DomainReview> {
  const found = single(customDomainSchema).safeParse(await read(path));
  if (!found.success) {
    return { warning: 'CloudChef couldn’t look up which address this changes; check it before approving.' };
  }
  const { hostname, service } = found.data.result;
  if (isOwn(hostname, service)) {
    return { refusal: OWN_REFUSAL };
  }
  return {
    warning: `${hostname} stops showing the Worker ${service}, and its visitors get an error until it is attached again.`,
  };
}

async function reviewRoutes(
  path: string,
  request: CloudflareApiRequest,
  read: DomainReviewRead,
): Promise<DomainReview> {
  const script = /\/workers\/scripts\/([^/]+)\/routes$/.exec(path)?.[1];
  const bodies = Array.isArray(request.body) ? request.body : [request.body];
  const routes = bodies.flatMap((body) => {
    const route = routeSchema.safeParse(body);
    return route.success ? [route.data] : [];
  });
  if (/\/workers\/routes\/[^/]+$/.test(path)) {
    const found = single(routeSchema).safeParse(await read(path));
    if (found.success) {
      routes.push(found.data.result);
    } else if (request.method === 'DELETE') {
      return { warning: 'CloudChef couldn’t look up which addresses this changes; check it before approving.' };
    }
  }
  for (const route of routes) {
    if (isOwn(route.pattern.split('/')[0] ?? '', route.script ?? script ?? '')) {
      return { refusal: OWN_REFUSAL };
    }
  }
  if (script && isCloudChefResourceName(decodeURIComponent(script))) {
    return { refusal: OWN_REFUSAL };
  }
  const patterns = routes.map((route) => route.pattern).join(', ');
  return {
    warning: patterns
      ? `Visitors to ${patterns} are sent to a different Worker than now, or to none; what those addresses show now may stop being reached.`
      : 'This changes which Worker some of the account’s addresses go to; what they show now may stop being reached.',
  };
}

function reviewWorkerDomains(path: string): DomainReview {
  const script = /\/workers\/scripts\/([^/]+)\//.exec(path)?.[1] ?? '';
  return isCloudChefResourceName(decodeURIComponent(script)) ? { refusal: OWN_REFUSAL } : { warning: null };
}

/** CloudChef's own hostname (or one below it), or one of CloudChef's own Workers. */
function isOwn(hostname: string, worker: string): boolean {
  const host = hostname.toLowerCase().replace(/^\*\.?/, '');
  return host === CLOUDCHEF_HOST || host.endsWith(`.${CLOUDCHEF_HOST}`) || isCloudChefResourceName(worker);
}
