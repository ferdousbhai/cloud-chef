import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAuthSession } from '~/lib/.server/auth';
import type { BillingConfig } from '~/lib/.server/billing/stripe';
import { applySubscription, findManagedSubscription } from '~/lib/cloudflare/data/managed-subscriptions.server';
import { MAX_SPACE_DOMAINS, normalizeHostname, spaceDomainSchema, spaceDomainsSchema } from '~/lib/space-domains';
import { controlPlaneDatabase, createProvenEmailUser, envWith } from '~/test/control-plane-d1';
import { connectDomainAction, listDomainsAction, removeDomainAction } from './space-domains';

const ORIGIN = 'https://cloudchef.build';
const HOST = 'host-org';
const ZONE = 'zone-1';
const TARGET = 'domains.cloudchef.build';
const billing: BillingConfig = {
  secretKey: 'sk_test',
  webhookSecret: null,
  priceId: 'price_1',
  portalConfigurationId: null,
  managedOrgId: HOST,
  creditPriceIds: {},
};

/** Cloudflare, as far as domains use it: the zone's custom hostnames and Worker routes, and the account's zones. */
function cloudflare(ownZones: readonly string[] = []) {
  const hostnames = new Map<string, { id: string; hostname: string; status: string; ssl: { status: string } }>();
  const routes = new Map<string, { id: string; pattern: string; script: string }>();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/client/v4', '');
      const method = init?.method ?? 'GET';
      const sent = <T>(schema: z.ZodType<T>): T => schema.parse(JSON.parse(String(init?.body)));
      const ok = <T>(result: T) => Response.json({ success: true, errors: [], result });
      if (path === '/zones') {
        return ok(ownZones.includes(url.searchParams.get('name') ?? '') ? [{ id: 'own-zone' }] : []);
      }
      if (path === `/zones/${ZONE}/custom_hostnames` && method === 'GET') {
        return ok([...hostnames.values()].filter((entry) => entry.hostname === url.searchParams.get('hostname')));
      }
      if (path === `/zones/${ZONE}/custom_hostnames` && method === 'POST') {
        const { hostname } = sent(z.object({ hostname: z.string() }));
        const entry = { id: `ch-${hostnames.size + 1}`, hostname, status: 'pending', ssl: { status: 'initializing' } };
        hostnames.set(entry.id, entry);
        return ok(entry);
      }
      if (path.startsWith(`/zones/${ZONE}/custom_hostnames/`) && method === 'DELETE') {
        hostnames.delete(path.split('/').at(-1) ?? '');
        return ok({});
      }
      if (path === `/zones/${ZONE}/workers/routes` && method === 'GET') {
        return ok([...routes.values()]);
      }
      if (path === `/zones/${ZONE}/workers/routes` && method === 'POST') {
        const route = {
          id: `route-${routes.size + 1}`,
          ...sent(z.object({ pattern: z.string(), script: z.string() })),
        };
        routes.set(route.id, route);
        return ok(route);
      }
      if (path.startsWith(`/zones/${ZONE}/workers/routes/`) && method === 'DELETE') {
        routes.delete(path.split('/').at(-1) ?? '');
        return ok({});
      }
      return Response.json({ success: false, errors: [{ code: 7003 }] }, { status: 404 });
    }),
  );
  return { hostnames, routes };
}

/** Sam, subscribed, with a published project in the space that made; and Gia, whom Sam invited. */
async function setup(configured = true) {
  const { database, db } = controlPlaneDatabase();
  const operator = await createProvenEmailUser(db, 'operator@cloudchef.example');
  database
    .prepare('INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)')
    .run(HOST, 'Host');
  database
    .prepare("INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', 1)")
    .run(HOST, operator.id);
  database
    .prepare(
      `INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
       VALUES ('host-connection', ?, 'account-1', 'active', 1, 1)`,
    )
    .run(HOST);
  const sam = await createProvenEmailUser(db, 'sam@example.com');
  await applySubscription(db, billing, {
    id: 'sub_1',
    customerId: 'cus_1',
    status: 'active',
    trialEndsAt: null,
    currentPeriodEndsAt: 2_000,
    cancelsAtPeriodEnd: false,
    userId: sam.id,
  });
  const spaceId = (await findManagedSubscription(db, sam.id))?.spaceOrgId ?? '';
  const connection = z
    .object({ id: z.string() })
    .parse(database.prepare('SELECT id FROM cloudflare_connections WHERE org_id = ?').get(spaceId));
  const addProject = database.prepare(
    `INSERT INTO org_projects (id, connection_id, org_id, name, artifact_repo, deploys_with, deploy_worker_name, created_from, created_at)
     VALUES (?, ?, ?, ?, ?, 'cloudchef', ?, 'chat', 1)`,
  );
  const published = crypto.randomUUID();
  const unpublished = crypto.randomUUID();
  addProject.run(published, connection.id, spaceId, 'Shop', 't-1', 'shop-worker');
  addProject.run(unpublished, connection.id, spaceId, 'Draft', 't-2', null);
  const gia = await createProvenEmailUser(db, 'gia@example.com');
  database
    .prepare("INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'member', 2)")
    .run(spaceId, gia.id);
  // SAFETY: the bindings' declared types are the empty text the configuration gives them, and the token is not
  // declared at all until it is set; the handlers read each only as text.
  const env = envWith({
    DB: db,
    ...(configured
      ? { MANAGED_DOMAINS_ZONE_ID: ZONE, MANAGED_DOMAINS_CNAME_TARGET: TARGET, MANAGED_DOMAINS_API_TOKEN: 'token' }
      : null),
  } as Partial<Env>);
  const cookieOf = async (userId: string) =>
    (await createAuthSession(env, userId, new Request(ORIGIN))).cookie.split(';')[0] ?? '';
  return { database, env, published, unpublished, sam: await cookieOf(sam.id), gia: await cookieOf(gia.id) };
}

function post(path: string, cookie: string, body: Readonly<Record<string, string>>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a domain of your own for a project in a space CloudChef runs', () => {
  it('is served from the project once its CNAME points at CloudChef, and stops when removed', async () => {
    const { env, published, sam } = await setup();
    const { hostnames, routes } = cloudflare();
    const list = async () => {
      const response = await listDomainsAction({
        request: new Request(`${ORIGIN}/api/domains?projectId=${published}`, { headers: { cookie: sam } }),
        env,
      });
      return spaceDomainsSchema.parse(await response.json());
    };
    await expect(list()).resolves.toEqual({ available: true, cnameTarget: TARGET, domains: [] });

    const connected = await connectDomainAction({
      request: post('/api/domains/connect', sam, { projectId: published, hostname: 'https://WWW.Example.com/' }),
      env,
    });
    expect(connected.status).toBe(201);
    const domain = spaceDomainSchema.parse(await connected.json());
    expect(domain).toMatchObject({ hostname: 'www.example.com', kind: 'connected', status: 'pending' });
    expect(domain.waitingFor).toContain(`points to ${TARGET}`);
    // Cloudflare was asked for the hostname, and to send it to the project's own Worker.
    expect([...hostnames.values()].map((entry) => entry.hostname)).toEqual(['www.example.com']);
    expect([...routes.values()]).toEqual([{ id: 'route-1', pattern: 'www.example.com/*', script: 'shop-worker' }]);

    // Their DNS record is found, then the certificate is issued.
    for (const entry of hostnames.values()) {
      entry.status = 'active';
    }
    expect((await list()).domains[0]).toMatchObject({
      status: 'pending',
      waitingFor: expect.stringContaining('certificate'),
    });
    for (const entry of hostnames.values()) {
      entry.ssl.status = 'active';
    }
    expect((await list()).domains[0]).toMatchObject({ status: 'active', waitingFor: null });

    const removed = await removeDomainAction({ request: post('/api/domains/remove', sam, { id: domain.id }), env });
    expect(removed.status).toBe(204);
    expect(hostnames.size).toBe(0);
    expect(routes.size).toBe(0);
    expect((await list()).domains).toEqual([]);
  });

  it('is given only to whoever runs the space, for a published project, and never a name that is not theirs to bring', async () => {
    const { env, published, unpublished, sam, gia } = await setup();
    const { hostnames, routes } = cloudflare(['operator.example']);
    const connect = async (cookie: string, projectId: string, hostname: string) =>
      (await connectDomainAction({ request: post('/api/domains/connect', cookie, { projectId, hostname }), env }))
        .status;
    // Someone invited into the space builds there, and does not point domains at its projects.
    expect(await connect(gia, published, 'www.example.com')).toBe(404);
    expect(await connect(sam, unpublished, 'www.example.com')).toBe(409);
    expect(await connect(sam, published, 'not a domain')).toBe(400);
    expect(await connect(sam, published, 'app.cloudchef.build')).toBe(400);
    // A name in a zone of the operator's own Cloudflare account is the operator's.
    expect(await connect(sam, published, 'shop.operator.example')).toBe(409);
    expect(hostnames.size).toBe(0);
    expect(routes.size).toBe(0);

    expect(await connect(sam, published, 'www.example.com')).toBe(201);
    expect(await connect(sam, published, 'www.example.com')).toBe(409);
    for (let count = 1; count < MAX_SPACE_DOMAINS; count += 1) {
      expect(await connect(sam, published, `site${count}.example.com`)).toBe(201);
    }
    expect(await connect(sam, published, 'onemore.example.com')).toBe(409);
    expect(hostnames.size).toBe(MAX_SPACE_DOMAINS);
  });

  it('is not offered where domains are not set up, and leaves nothing behind when Cloudflare refuses', async () => {
    const unset = await setup(false);
    cloudflare();
    const none = await listDomainsAction({
      request: new Request(`${ORIGIN}/api/domains?projectId=${unset.published}`, { headers: { cookie: unset.sam } }),
      env: unset.env,
    });
    await expect(none.json()).resolves.toEqual({ available: false, cnameTarget: null, domains: [] });

    const { database, env, published, sam } = await setup();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) =>
        (init?.method ?? 'GET') === 'POST' && String(input).includes('/workers/routes')
          ? Response.json({ success: false, errors: [{ code: 10020 }] }, { status: 400 })
          : Response.json({
              success: true,
              errors: [],
              result:
                String(input).includes('custom_hostnames') && init?.method === 'POST'
                  ? { id: 'ch-1', hostname: 'www.example.com' }
                  : [],
            }),
      ),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = await connectDomainAction({
      request: post('/api/domains/connect', sam, { projectId: published, hostname: 'www.example.com' }),
      env,
    });
    expect(refused.status).toBe(502);
    expect(database.prepare('SELECT COUNT(*) AS domains FROM space_domains').get()).toEqual({ domains: 0 });
  });
});

describe('a hostname as typed', () => {
  it.each([
    ['WWW.Example.com', 'www.example.com'],
    ['https://shop.example.co.uk/path?x=1', 'shop.example.co.uk'],
    ['example.com.', 'example.com'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
  ])('reads %s as %s', (typed, hostname) => {
    expect(normalizeHostname(typed)).toBe(hostname);
  });

  it.each(['localhost', 'example', '192.168.1.1', '-bad.example.com', 'a b.com', 'x.workers.dev', 'cloudchef.build'])(
    'refuses %s',
    (typed) => {
      expect(normalizeHostname(typed)).toBeNull();
    },
  );
});
