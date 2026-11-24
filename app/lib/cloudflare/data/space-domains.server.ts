/**
 * The domains of spaces CloudChef runs (`migrations/0072_space_domains.sql`): which hostname serves which
 * project, how it got here, and whether Cloudflare serves it yet.
 */
export type SpaceDomainRecord = {
  id: string;
  orgId: string;
  projectId: string | null;
  hostname: string;
  kind: 'connected' | 'bought';
  status: 'pending' | 'active' | 'failed';
  /** A bought domain's yearly Stripe subscription, once its checkout completed. */
  subscriptionId: string | null;
  /** What that subscription charges each year, in cents. */
  yearlyPriceCents: number | null;
  /** When a bought domain's registration runs to; null until it is registered. */
  expiresAt: number | null;
};

type Row = {
  id: string;
  org_id: string;
  project_id: string | null;
  hostname: string;
  kind: SpaceDomainRecord['kind'];
  status: SpaceDomainRecord['status'];
  stripe_subscription_id: string | null;
  yearly_price_cents: number | null;
  expires_at: number | null;
};

const COLUMNS =
  'id, org_id, project_id, hostname, kind, status, stripe_subscription_id, yearly_price_cents, expires_at';

function fromRow(row: Row): SpaceDomainRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    hostname: row.hostname,
    kind: row.kind,
    status: row.status,
    subscriptionId: row.stripe_subscription_id,
    yearlyPriceCents: row.yearly_price_cents,
    expiresAt: row.expires_at,
  };
}

export async function listProjectDomains(db: D1Database, projectId: string): Promise<SpaceDomainRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM space_domains WHERE project_id = ? ORDER BY created_at, hostname`)
    .bind(projectId)
    .all<Row>();
  return results.map(fromRow);
}

export async function findSpaceDomain(db: D1Database, id: string): Promise<SpaceDomainRecord | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM space_domains WHERE id = ?`).bind(id).first<Row>();
  return row ? fromRow(row) : null;
}

/** How long a purchase may sit with its checkout unfinished before its name is free again. */
const UNFINISHED_PURCHASE_MS = 60 * 60_000;

/** Whether the team is a space CloudChef runs: only those have domains CloudChef serves. */
export async function isManagedSpace(db: D1Database, orgId: string | null): Promise<boolean> {
  if (!orgId) {
    return false;
  }
  const row = await db
    .prepare('SELECT 1 AS managed FROM organizations WHERE id = ? AND managed_host_org_id IS NOT NULL')
    .bind(orgId)
    .first<{ managed: number }>();
  return row !== null;
}

/**
 * Claims a hostname for a project, while nobody has it and the space has fewer than `limit`, in one write, so
 * two people asking for the same name at once can't both get it. Says which of the two refused it.
 */
export async function claimSpaceDomain(
  db: D1Database,
  domain: {
    orgId: string;
    projectId: string;
    hostname: string;
    kind: SpaceDomainRecord['kind'];
    userId: string;
    /** What a bought domain's subscription will charge each year. */
    yearlyPriceCents?: number;
  },
  limit: number,
): Promise<SpaceDomainRecord | 'taken' | 'limit'> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const yearlyPriceCents = domain.yearlyPriceCents ?? null;
  const [, result] = await db.batch([
    // A purchase whose checkout was never finished gives its name and its place back after an hour.
    db
      .prepare(
        `DELETE FROM space_domains
         WHERE kind = 'bought' AND status = 'pending' AND stripe_subscription_id IS NULL AND created_at < ?`,
      )
      .bind(now - UNFINISHED_PURCHASE_MS),
    db
      .prepare(
        `INSERT INTO space_domains
           (id, org_id, project_id, hostname, kind, status, yearly_price_cents, created_by, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?9, ?6, ?7, ?7
         WHERE (SELECT COUNT(*) FROM space_domains WHERE org_id = ?2) < ?8
         ON CONFLICT(hostname) DO NOTHING`,
      )
      .bind(
        id,
        domain.orgId,
        domain.projectId,
        domain.hostname,
        domain.kind,
        domain.userId,
        now,
        limit,
        yearlyPriceCents,
      ),
  ]);
  if (result?.meta.changes === 1) {
    return {
      id,
      orgId: domain.orgId,
      projectId: domain.projectId,
      hostname: domain.hostname,
      kind: domain.kind,
      status: 'pending',
      subscriptionId: null,
      yearlyPriceCents,
      expiresAt: null,
    };
  }
  const holder = await db
    .prepare('SELECT 1 AS held FROM space_domains WHERE hostname = ?')
    .bind(domain.hostname)
    .first();
  return holder ? 'taken' : 'limit';
}

export async function setSpaceDomainStatus(
  db: D1Database,
  id: string,
  status: SpaceDomainRecord['status'],
): Promise<void> {
  await db
    .prepare('UPDATE space_domains SET status = ?, updated_at = ? WHERE id = ? AND status <> ?')
    .bind(status, Date.now(), id, status)
    .run();
}

export async function deleteSpaceDomain(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM space_domains WHERE id = ?').bind(id).run();
}

/**
 * Records the subscription that pays for a bought domain, once: true for the one caller that may go on to
 * register it, however many times its finished checkout is reported.
 */
export async function claimDomainPurchase(db: D1Database, id: string, subscriptionId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE space_domains SET stripe_subscription_id = ?2, updated_at = ?3
       WHERE id = ?1 AND kind = 'bought' AND stripe_subscription_id IS NULL`,
    )
    .bind(id, subscriptionId, Date.now())
    .run();
  return result.meta.changes === 1;
}

/** Notes that a bought domain is registered, and when its registration runs to. */
export async function setSpaceDomainRegistered(db: D1Database, id: string, expiresAt: number): Promise<void> {
  await db
    .prepare('UPDATE space_domains SET expires_at = ?, updated_at = ? WHERE id = ?')
    .bind(expiresAt, Date.now(), id)
    .run();
}

export async function findSpaceDomainBySubscription(
  db: D1Database,
  subscriptionId: string,
): Promise<SpaceDomainRecord | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM space_domains WHERE stripe_subscription_id = ?`)
    .bind(subscriptionId)
    .first<Row>();
  return row ? fromRow(row) : null;
}

/** The Worker CloudChef deploys the domain's project as, while it has a project that is published. */
export async function domainWorkerName(db: D1Database, projectId: string | null): Promise<string | null> {
  if (!projectId) {
    return null;
  }
  const row = await db
    .prepare("SELECT deploy_worker_name FROM org_projects WHERE id = ? AND deploys_with = 'cloudchef'")
    .bind(projectId)
    .first<{ deploy_worker_name: string | null }>();
  return row?.deploy_worker_name ?? null;
}
