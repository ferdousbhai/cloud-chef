import { z } from 'zod';
import {
  createCustomHostname,
  deleteCustomHostname,
  deleteHostnameRoute,
  hostnameIsInOwnAccount,
  ManagedDomainsError,
  managedDomainsConfig,
  readCustomHostname,
  routeHostnameToWorker,
  type ManagedDomainsConfig,
} from '~/lib/.server/cloudflare/managed-domains-api';
import { readJsonRequest } from '~/lib/.server/request-guards';
import { requireManagedProject, type Project } from '~/lib/cloudflare/data/org-projects.server';
import { OrganizationError } from '~/lib/cloudflare/data/organizations.server';
import {
  claimSpaceDomain,
  deleteSpaceDomain,
  findSpaceDomain,
  isManagedSpace,
  listProjectDomains,
  setSpaceDomainStatus,
  type SpaceDomainRecord,
} from '~/lib/cloudflare/data/space-domains.server';
import { MAX_SPACE_DOMAINS, normalizeHostname, type SpaceDomain, type SpaceDomains } from '~/lib/space-domains';
import { signedIn } from './signed-in';

/**
 * A project's own domains, in a space CloudChef runs. A space can't change the Cloudflare account it builds in,
 * so whoever runs the space asks here and CloudChef does it with the operator's own token: a domain they
 * bought elsewhere is served once its CNAME points at CloudChef (`connectDomainAction`). Each hostname serves
 * one project, the one whose Worker CloudChef deploys.
 */
const connectSchema = z.strictObject({ projectId: z.string().uuid(), hostname: z.string().min(1).max(300) });
const removeSchema = z.strictObject({ id: z.string().uuid() });
const UNAVAILABLE: SpaceDomains = { available: false, cnameTarget: null, domains: [] };

/** The project, for the person who runs it, with what serving a domain for it needs; null where it has none. */
async function domainProject(
  env: Env,
  userId: string,
  projectId: string,
): Promise<{ project: Project & { orgId: string }; config: ManagedDomainsConfig } | null> {
  const project = await requireManagedProject(env.DB, userId, projectId);
  const config = managedDomainsConfig(env);
  const { orgId } = project;
  if (!config || !orgId || !(await isManagedSpace(env.DB, orgId))) {
    return null;
  }
  return { project: { ...project, orgId }, config };
}

/** What Cloudflare still waits for before the hostname serves the project, and whether it does. */
async function connectedState(
  config: ManagedDomainsConfig,
  record: SpaceDomainRecord,
): Promise<{ status: SpaceDomainRecord['status']; waitingFor: string | null }> {
  const hostname = await readCustomHostname(config, record.hostname).catch(() => undefined);
  if (hostname === undefined) {
    return {
      status: record.status,
      waitingFor: record.status === 'active' ? null : 'Cloudflare could not be asked just now.',
    };
  }
  if (!hostname?.pointsHere) {
    return {
      status: 'pending',
      waitingFor: `Add a CNAME record for ${record.hostname} that points to ${config.cnameTarget}, where you manage the domain’s DNS. It is usually found within a few minutes.`,
    };
  }
  if (!hostname.certificateIssued) {
    return {
      status: 'pending',
      waitingFor: 'Your DNS record is found. Its certificate is being issued, which takes a few minutes.',
    };
  }
  return { status: 'active', waitingFor: null };
}

async function described(env: Env, config: ManagedDomainsConfig, record: SpaceDomainRecord): Promise<SpaceDomain> {
  // One that already serves is not asked about again: a certificate renews without the person doing anything.
  const state =
    record.kind === 'connected' && record.status === 'pending'
      ? await connectedState(config, record)
      : { status: record.status, waitingFor: null };
  if (state.status !== record.status) {
    await setSpaceDomainStatus(env.DB, record.id, state.status);
  }
  return {
    id: record.id,
    hostname: record.hostname,
    kind: record.kind,
    status: state.status,
    waitingFor: state.waitingFor,
  };
}

/** `GET /api/domains?projectId=`: the project's domains, and where each stands at Cloudflare now. */
export function listDomainsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const projectId = z.string().uuid().safeParse(new URL(request.url).searchParams.get('projectId'));
    if (!projectId.success) {
      return Response.json({ error: 'Choose a project.' }, { status: 400 });
    }
    const found = await domainProject(env, session.user.id, projectId.data);
    if (!found) {
      return Response.json(UNAVAILABLE, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const records = await listProjectDomains(env.DB, found.project.id);
    const answer: SpaceDomains = {
      available: true,
      cnameTarget: found.config.cnameTarget,
      domains: await Promise.all(records.map((record) => described(env, found.config, record))),
    };
    return Response.json(answer, { headers: { 'Cache-Control': 'private, no-store' } });
  });
}

/**
 * `POST /api/domains/connect`: serves a domain the person bought elsewhere from the project, once its CNAME
 * points at CloudChef. Nothing proves the domain is theirs but that record: until it exists Cloudflare serves
 * nothing for the name, and whoever controls the domain's DNS decides where it points.
 */
export function connectDomainAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, connectSchema, 'Enter the domain to connect.');
    if ('response' in body) {
      return body.response;
    }
    const found = await domainProject(env, session.user.id, body.data.projectId);
    if (!found) {
      throw new OrganizationError('Domains are for projects in a space CloudChef runs.', 409);
    }
    const { project, config } = found;
    const hostname = normalizeHostname(body.data.hostname);
    if (!hostname) {
      throw new OrganizationError('That is not a domain name. Enter one like www.example.com.', 400);
    }
    if (project.deploysWith !== 'cloudchef' || !project.deployWorkerName) {
      throw new OrganizationError('Publish the project first: a domain needs a live site to serve.', 409);
    }
    try {
      if (await hostnameIsInOwnAccount(config, hostname)) {
        throw new OrganizationError('That domain can’t be connected here.', 409);
      }
      const claimed = await claimSpaceDomain(
        env.DB,
        { orgId: project.orgId, projectId: project.id, hostname, kind: 'connected', userId: session.user.id },
        MAX_SPACE_DOMAINS,
      );
      if (claimed === 'taken') {
        throw new OrganizationError(`${hostname} is already connected to a project.`, 409);
      }
      if (claimed === 'limit') {
        throw new OrganizationError(`A space can have ${MAX_SPACE_DOMAINS} domains. Remove one first.`, 409);
      }
      try {
        await createCustomHostname(config, hostname);
        await routeHostnameToWorker(config, hostname, project.deployWorkerName);
      } catch (error) {
        // Nothing half-made is left claiming the name.
        await removeFromCloudflare(config, hostname).catch(() => undefined);
        await deleteSpaceDomain(env.DB, claimed.id);
        throw error;
      }
      return Response.json(await described(env, config, claimed), { status: 201 });
    } catch (error) {
      if (error instanceof ManagedDomainsError) {
        return cloudflareUnavailable();
      }
      throw error;
    }
  });
}

/** `POST /api/domains/remove`: stops serving a connected domain from its project. */
export function removeDomainAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, removeSchema, 'Choose a domain to remove.');
    if ('response' in body) {
      return body.response;
    }
    const record = await findSpaceDomain(env.DB, body.data.id);
    const found = record?.projectId ? await domainProject(env, session.user.id, record.projectId) : null;
    if (!record || !found) {
      throw new OrganizationError('That domain isn’t yours to change.', 404);
    }
    if (record.kind !== 'connected') {
      throw new OrganizationError('A domain bought here is managed with its subscription.', 409);
    }
    try {
      await removeFromCloudflare(found.config, record.hostname);
    } catch (error) {
      if (error instanceof ManagedDomainsError) {
        return cloudflareUnavailable();
      }
      throw error;
    }
    await deleteSpaceDomain(env.DB, record.id);
    return new Response(null, { status: 204 });
  });
}

/**
 * Stops serving every domain connected to a project, before the project is deleted: its Worker is gone, and the
 * names are free to connect elsewhere. False when Cloudflare could not be told; deleting again finishes it.
 */
export async function disconnectProjectDomains(env: Env, projectId: string): Promise<boolean> {
  const config = managedDomainsConfig(env);
  const connected = (await listProjectDomains(env.DB, projectId)).filter((record) => record.kind === 'connected');
  if (connected.length === 0) {
    return true;
  }
  if (!config) {
    return false;
  }
  try {
    for (const record of connected) {
      await removeFromCloudflare(config, record.hostname);
      await deleteSpaceDomain(env.DB, record.id);
    }
    return true;
  } catch (error) {
    if (error instanceof ManagedDomainsError) {
      return false;
    }
    throw error;
  }
}

/** The route first, so the name stops reaching the project even if the hostname itself can't be removed. */
async function removeFromCloudflare(config: ManagedDomainsConfig, hostname: string): Promise<void> {
  await deleteHostnameRoute(config, hostname);
  await deleteCustomHostname(config, hostname);
}

function cloudflareUnavailable(): Response {
  return Response.json({ error: 'Cloudflare could not set that up just now. Try again shortly.' }, { status: 502 });
}
