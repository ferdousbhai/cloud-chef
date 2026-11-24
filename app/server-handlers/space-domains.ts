import { z } from 'zod';
import {
  attachDomainToWorker,
  checkDomainOffer,
  createCustomHostname,
  deleteCustomHostname,
  deleteHostnameRoute,
  hostnameIsInOwnAccount,
  ManagedDomainsError,
  managedDomainsConfig,
  readCustomHostname,
  readRegistration,
  registerDomain,
  routeHostnameToWorker,
  searchDomainOffers,
  setDomainAutoRenew,
  type ManagedDomainsConfig,
  type RegistrationState,
} from '~/lib/.server/cloudflare/managed-domains-api';
import { registrantFrom } from '~/lib/.server/billing/registrant';
import {
  billingConfig,
  cancelSubscription,
  chargeSubscriptionNow,
  createDomainCheckout,
  readDomainCheckout,
  StripeError,
  type BillingConfig,
  type StripeSubscription,
} from '~/lib/.server/billing/stripe';
import { publicOrigin } from '~/lib/.server/public-origin';
import { findManagedSubscription, givesSpace } from '~/lib/cloudflare/data/managed-subscriptions.server';
import { readJsonRequest } from '~/lib/.server/request-guards';
import { requireManagedProject, type Project } from '~/lib/cloudflare/data/org-projects.server';
import { OrganizationError } from '~/lib/cloudflare/data/organizations.server';
import {
  claimDomainPurchase,
  claimSpaceDomain,
  deleteSpaceDomain,
  domainWorkerName,
  findSpaceDomain,
  findSpaceDomainBySubscription,
  isManagedSpace,
  listProjectDomains,
  setSpaceDomainRegistered,
  setSpaceDomainStatus,
  type SpaceDomainRecord,
} from '~/lib/cloudflare/data/space-domains.server';
import {
  DOMAIN_YEARLY_MARGIN_CENTS,
  MAX_SPACE_DOMAINS,
  normalizeHostname,
  type DomainOffer,
  type SpaceDomain,
  type SpaceDomains,
} from '~/lib/space-domains';
import { signedIn } from './signed-in';

/**
 * A project's own domains, in a space CloudChef runs. A space can't change the Cloudflare account it builds in,
 * so whoever runs the space asks here and CloudChef does it with the operator's own token: a domain they
 * bought elsewhere is served once its CNAME points at CloudChef (`connectDomainAction`), and a domain can be
 * bought here (`buyDomainAction`): registered in the operator's Cloudflare account in the buyer's own name, paid
 * for by a yearly Stripe subscription of its own, and served from the project. Each hostname serves one project,
 * the one whose Worker CloudChef deploys.
 */
const connectSchema = z.strictObject({ projectId: z.string().uuid(), hostname: z.string().min(1).max(300) });
const removeSchema = z.strictObject({ id: z.string().uuid() });
const buySchema = z.strictObject({ projectId: z.string().uuid(), hostname: z.string().min(1).max(300) });
const UNAVAILABLE: SpaceDomains = { available: false, cnameTarget: null, buying: false, domains: [] };
/** Where the return from a domain's checkout is read (`completeCheckoutAction`). */
const BILLING_RETURN_PATH = '/api/billing/return';

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
    record.status !== 'pending'
      ? {
          status: record.status,
          waitingFor:
            record.status === 'failed'
              ? 'It could not be registered, and you were not charged. Remove it, then try again or choose another name.'
              : null,
        }
      : record.kind === 'connected'
        ? await connectedState(config, record)
        : await boughtState(env, config, record);
  if (state.status !== record.status) {
    await setSpaceDomainStatus(env.DB, record.id, state.status);
  }
  return {
    id: record.id,
    hostname: record.hostname,
    kind: record.kind,
    status: state.status,
    waitingFor: state.waitingFor,
    yearlyPriceUsd: record.yearlyPriceCents === null ? null : record.yearlyPriceCents / 100,
  };
}

/** Whether a domain can be bought: the account to register it in and the Stripe product to charge for it. */
function buyingConfig(env: Env, config: ManagedDomainsConfig): (BillingConfig & { domainProductId: string }) | null {
  const billing = billingConfig(env);
  const domainProductId = billing?.domainProductId;
  return billing && domainProductId && config.accountId ? { ...billing, domainProductId } : null;
}

/** What the buyer pays each year for a name that costs the operator `costCents`. */
function yearlyPriceCents(costCents: number): number {
  return costCents + DOMAIN_YEARLY_MARGIN_CENTS;
}

/** A registration that stopped for good: its subscription is cancelled before anything is charged. */
async function stopPurchase(
  billing: BillingConfig,
  record: SpaceDomainRecord & { subscriptionId: string },
): Promise<{ status: 'failed'; waitingFor: string }> {
  await cancelSubscription(billing, record.subscriptionId).catch(() => undefined);
  console.error({ event: 'domain_registration_failed', domainId: record.id });
  return {
    status: 'failed',
    waitingFor:
      'It could not be registered, and you were not charged. Remove it, then try again or choose another name.',
  };
}

/**
 * Takes a bought domain's purchase as far as it can go now, and says where it stands: registered at Cloudflare,
 * attached to its project's Worker, and only then charged for. A registration that stopped for good cancels
 * the subscription before anything is charged.
 */
async function boughtState(
  env: Env,
  config: ManagedDomainsConfig,
  record: SpaceDomainRecord,
  /** The registration's answer, when it was just asked for. */
  registered?: RegistrationState,
): Promise<{ status: SpaceDomainRecord['status']; waitingFor: string | null }> {
  const billing = billingConfig(env);
  const { subscriptionId } = record;
  if (!subscriptionId || !billing) {
    return { status: 'pending', waitingFor: 'Its checkout was not finished. Nothing was charged.' };
  }
  try {
    let expiresAt = record.expiresAt;
    if (expiresAt === null) {
      const registration = registered ?? (await readRegistration(config, record.hostname));
      if (registration.state !== 'registered') {
        return registration.state === 'pending'
          ? { status: 'pending', waitingFor: 'It is being registered, which can take a few minutes.' }
          : stopPurchase(billing, { ...record, subscriptionId });
      }
      // A year from now where the registry did not say: only shown, and corrected by nothing that matters.
      expiresAt = registration.expiresAt ?? Date.now() + 365 * 24 * 60 * 60_000;
      await setSpaceDomainRegistered(env.DB, record.id, expiresAt);
    }
    const worker = await domainWorkerName(env.DB, record.projectId);
    if (worker && !(await attachDomainToWorker(config, record.hostname, worker))) {
      return { status: 'pending', waitingFor: 'It is registered and being set up, which takes a few minutes.' };
    }
    // Registered and pointed at the project: now, and only now, the first year is charged.
    await chargeSubscriptionNow(billing, subscriptionId);
    return { status: 'active', waitingFor: null };
  } catch (error) {
    if (error instanceof StripeError) {
      // Stripe was asked only to charge: it already has (this ran before), or it will itself when the first day ends.
      return { status: 'active', waitingFor: null };
    }
    if (error instanceof ManagedDomainsError) {
      return { status: 'pending', waitingFor: 'Cloudflare could not be asked just now.' };
    }
    throw error;
  }
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
      buying: buyingConfig(env, found.config) !== null,
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

/** `POST /api/domains/remove`: stops serving a connected domain from its project, or clears a purchase that did not go through. */
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
    if (record.kind === 'bought' && record.status === 'active') {
      throw new OrganizationError(
        'A domain bought here is yours for the year paid for. To stop it renewing, cancel it under Card, invoices, cancel in Settings.',
        409,
      );
    }
    if (record.kind === 'bought' && record.subscriptionId && record.status === 'pending') {
      throw new OrganizationError('It is still being registered. Try again in a few minutes.', 409);
    }
    try {
      if (record.kind === 'connected') {
        await removeFromCloudflare(found.config, record.hostname);
      }
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

/** `GET /api/domains/search?projectId=&q=`: names like `q` that can be bought, with what each costs a year. */
export function searchDomainsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const query = new URL(request.url).searchParams;
    const projectId = z.string().uuid().safeParse(query.get('projectId'));
    const asked = z.string().trim().min(2).max(80).safeParse(query.get('q'));
    if (!projectId.success || !asked.success) {
      return Response.json({ error: 'Type a name to look for.' }, { status: 400 });
    }
    const found = await domainProject(env, session.user.id, projectId.data);
    if (!found || !buyingConfig(env, found.config)) {
      throw new OrganizationError('Domains can’t be bought here yet.', 409);
    }
    try {
      const offers: DomainOffer[] = (await searchDomainOffers(found.config, asked.data)).map((offer) => ({
        hostname: offer.name,
        yearlyPriceUsd: yearlyPriceCents(offer.yearlyCostCents) / 100,
      }));
      return Response.json({ offers }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      if (error instanceof ManagedDomainsError) {
        return cloudflareUnavailable();
      }
      throw error;
    }
  });
}

/**
 * `POST /api/domains/buy`: Stripe's page for a domain's yearly subscription. The name and its price are asked of
 * the registry again here, never taken from the browser; the name is held for this project while the checkout
 * is open, and registered when it completes (`completeDomainPurchase`).
 */
export function buyDomainAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, buySchema, 'Choose a domain to buy.');
    if ('response' in body) {
      return body.response;
    }
    const found = await domainProject(env, session.user.id, body.data.projectId);
    const billing = found ? buyingConfig(env, found.config) : null;
    // Whoever runs a space is its subscriber: the domain is charged to the customer their subscription has.
    const subscription = await findManagedSubscription(env.DB, session.user.id);
    if (!found || !billing || !subscription || !givesSpace(subscription.status)) {
      throw new OrganizationError('Domains can’t be bought here yet.', 409);
    }
    const { project, config } = found;
    const hostname = normalizeHostname(body.data.hostname);
    if (!hostname) {
      throw new OrganizationError('That is not a domain name.', 400);
    }
    if (project.deploysWith !== 'cloudchef' || !project.deployWorkerName) {
      throw new OrganizationError('Publish the project first: a domain needs a live site to serve.', 409);
    }
    try {
      const offer = await checkDomainOffer(config, hostname);
      if (!offer) {
        throw new OrganizationError(`${hostname} can’t be bought here. Choose another name.`, 409);
      }
      const price = yearlyPriceCents(offer.yearlyCostCents);
      const claimed = await claimSpaceDomain(
        env.DB,
        {
          orgId: project.orgId,
          projectId: project.id,
          hostname,
          kind: 'bought',
          userId: session.user.id,
          yearlyPriceCents: price,
        },
        MAX_SPACE_DOMAINS,
      );
      if (claimed === 'taken') {
        throw new OrganizationError(`${hostname} is already being bought or connected.`, 409);
      }
      if (claimed === 'limit') {
        throw new OrganizationError(`A space can have ${MAX_SPACE_DOMAINS} domains. Remove one first.`, 409);
      }
      try {
        const origin = publicOrigin(request);
        const url = await createDomainCheckout(billing, {
          customerId: subscription.customerId,
          userId: session.user.id,
          domainId: claimed.id,
          hostname,
          yearlyPriceCents: price,
          productId: billing.domainProductId,
          // Stripe writes the checkout's own id over the placeholder.
          successUrl: `${origin}${BILLING_RETURN_PATH}?domain={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${origin}/`,
        });
        return Response.json({ url }, { status: 201 });
      } catch (error) {
        await deleteSpaceDomain(env.DB, claimed.id);
        if (error instanceof StripeError) {
          return Response.json({ error: 'Payments are unavailable right now. Try again shortly.' }, { status: 502 });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof ManagedDomainsError) {
        return cloudflareUnavailable();
      }
      throw error;
    }
  });
}

/**
 * A finished checkout for a domain: registers it in the buyer's name, once however often the checkout is
 * reported (the return from Stripe's page, and its webhook), then takes it as far as it can go. `userId`, when
 * given, must be who the checkout was started for. Returns the project it is for, or null when the checkout
 * is not a domain's.
 */
export async function completeDomainPurchase(
  env: Env,
  checkoutSessionId: string,
  userId: string | null,
): Promise<{ projectId: string | null } | null> {
  const billing = billingConfig(env);
  const config = managedDomainsConfig(env);
  if (!billing || !config) {
    return null;
  }
  const checkout = await readDomainCheckout(billing, checkoutSessionId);
  if (!checkout || (userId !== null && checkout.userId !== userId)) {
    return null;
  }
  const record = await findSpaceDomain(env.DB, checkout.domainId);
  if (!record || record.kind !== 'bought') {
    // The name was given back (an abandoned checkout finished after its hour): nothing to register, so no charge.
    await cancelSubscription(billing, checkout.subscriptionId).catch(() => undefined);
    return null;
  }
  if (!(await claimDomainPurchase(env.DB, record.id, checkout.subscriptionId))) {
    return { projectId: record.projectId };
  }
  const paid = { ...record, subscriptionId: checkout.subscriptionId };
  const registrant = registrantFrom(checkout.contact);
  let registered: RegistrationState;
  try {
    registered = registrant ? await registerDomain(config, record.hostname, registrant) : { state: 'failed' };
  } catch (error) {
    if (!(error instanceof ManagedDomainsError)) {
      throw error;
    }
    // Cloudflare refused it, or could not be reached: either way nothing is registered, so nothing is charged.
    registered = { state: 'failed' };
  }
  const state = await boughtState(env, config, paid, registered);
  await setSpaceDomainStatus(env.DB, record.id, state.status);
  return { projectId: record.projectId };
}

/**
 * What Stripe says about a bought domain's subscription: while it is paid for and not set to end, Cloudflare
 * renews the registration each year; once it is cancelled or unpaid, it is left to run out.
 */
export async function applyDomainSubscription(env: Env, subscription: StripeSubscription): Promise<void> {
  const config = managedDomainsConfig(env);
  const record = await findSpaceDomainBySubscription(env.DB, subscription.id);
  // Not registered yet (or never): there is no registration to renew or to stop renewing.
  if (!config || !record || record.expiresAt === null) {
    return;
  }
  const renews = givesSpace(subscription.status) && !subscription.cancelsAtPeriodEnd;
  await setDomainAutoRenew(config, record.hostname, renews);
}
