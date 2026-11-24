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
};

type Row = {
  id: string;
  org_id: string;
  project_id: string | null;
  hostname: string;
  kind: SpaceDomainRecord['kind'];
  status: SpaceDomainRecord['status'];
};

const COLUMNS = 'id, org_id, project_id, hostname, kind, status';

function fromRow(row: Row): SpaceDomainRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    hostname: row.hostname,
    kind: row.kind,
    status: row.status,
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
  domain: { orgId: string; projectId: string; hostname: string; kind: SpaceDomainRecord['kind']; userId: string },
  limit: number,
): Promise<SpaceDomainRecord | 'taken' | 'limit'> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO space_domains (id, org_id, project_id, hostname, kind, status, created_by, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?7
       WHERE (SELECT COUNT(*) FROM space_domains WHERE org_id = ?2) < ?8
       ON CONFLICT(hostname) DO NOTHING`,
    )
    .bind(id, domain.orgId, domain.projectId, domain.hostname, domain.kind, domain.userId, now, limit)
    .run();
  if (result.meta.changes === 1) {
    return {
      id,
      orgId: domain.orgId,
      projectId: domain.projectId,
      hostname: domain.hostname,
      kind: domain.kind,
      status: 'pending',
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
