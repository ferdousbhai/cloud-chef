import { z } from 'zod';
import { getJson, postJson } from '~/lib/json-request';
import {
  domainOffersSchema,
  spaceDomainSchema,
  spaceDomainsSchema,
  type DomainOffer,
  type SpaceDomain,
  type SpaceDomains,
} from '~/lib/space-domains';

export function readProjectDomains(projectId: string): Promise<SpaceDomains> {
  return getJson(
    `/api/domains?projectId=${encodeURIComponent(projectId)}`,
    spaceDomainsSchema,
    'Unable to load this project’s domains.',
  );
}

/** Asks CloudChef to serve a domain bought elsewhere from the project; it serves once its CNAME points here. */
export function connectDomain(projectId: string, hostname: string): Promise<SpaceDomain> {
  return postJson('/api/domains/connect', { projectId, hostname }, spaceDomainSchema, 'Unable to connect the domain.');
}

export async function removeDomain(id: string): Promise<void> {
  await postJson('/api/domains/remove', { id }, z.unknown(), 'Unable to remove the domain.');
}

/** Names like `query` that can be bought for the project, with what each costs a year. */
export async function searchDomains(projectId: string, query: string): Promise<DomainOffer[]> {
  const { offers } = await getJson(
    `/api/domains/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`,
    domainOffersSchema,
    'Unable to look for domains.',
  );
  return offers;
}

/** Leaves for Stripe's page to pay for the domain, which returns to the project's domains with it registered. */
export async function buyDomain(projectId: string, hostname: string): Promise<void> {
  const { url } = await postJson(
    '/api/domains/buy',
    { projectId, hostname },
    z.object({ url: z.url() }),
    'Unable to buy the domain.',
  );
  window.location.assign(url);
}
