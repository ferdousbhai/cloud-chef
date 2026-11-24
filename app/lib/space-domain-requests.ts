import { z } from 'zod';
import { getJson, postJson } from '~/lib/json-request';
import { spaceDomainSchema, spaceDomainsSchema, type SpaceDomain, type SpaceDomains } from '~/lib/space-domains';

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
