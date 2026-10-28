import { nativeProjectRepo } from '~/lib/.server/cloudflare/project-repository';
import { freeSlug, type ProjectVisibility } from './org-projects.server';

/**
 * Apps made in a chat (CloudChef apps), as CloudChef itself knows them: who owns them, in which account, their
 * repository, name and address name, whether they're public, and their live address as the owner's runtime's
 * deploys recorded it. Each runtime keeps its own person's rows current (`syncApps`).
 */
type App = {
  id: string;
  userId: string;
  connectionId: string;
  repo: string;
  name: string;
  /** `<owner's username>/<slug>`; null until the owner has a username. */
  fullName: string | null;
  visibility: ProjectVisibility;
  siteUrl: string | null;
  createdAt: number;
};

type AppRow = {
  id: string;
  user_id: string;
  connection_id: string;
  repo: string;
  name: string;
  slug: string;
  visibility: ProjectVisibility;
  site_url: string | null;
  created_at: number;
  owner_username: string | null;
};

const APP_COLUMNS = `apps.id, apps.user_id, apps.connection_id, apps.repo, apps.name, apps.slug, apps.visibility,
  apps.site_url, apps.created_at, (SELECT username FROM "user" WHERE "user".id = apps.user_id) AS owner_username`;

function toApp(row: AppRow): App {
  return {
    id: row.id,
    userId: row.user_id,
    connectionId: row.connection_id,
    repo: row.repo,
    name: row.name,
    fullName: row.owner_username ? `${row.owner_username}/${row.slug}` : null,
    visibility: row.visibility,
    siteUrl: row.site_url,
    createdAt: row.created_at,
  };
}

/**
 * Brings the person's apps in one account up to date with what their runtime lists: new ones are added (private,
 * with a free address name), names and live addresses follow, and apps no longer there (deleted) are removed.
 */
export async function syncApps(
  db: D1Database,
  args: { userId: string; connectionId: string; apps: { id: string; name: string; siteUrl: string | null }[] },
): Promise<void> {
  const now = Date.now();
  const { results } = await db
    .prepare('SELECT id FROM apps WHERE user_id = ? AND connection_id = ?')
    .bind(args.userId, args.connectionId)
    .all<{ id: string }>();
  const known = new Set(results.map((row) => row.id));
  const listed = new Set(args.apps.map((app) => app.id));
  const statements: D1PreparedStatement[] = [];
  for (const app of args.apps) {
    if (known.has(app.id)) {
      statements.push(
        db
          .prepare(
            `UPDATE apps SET name = ?, site_url = ?, updated_at = ?
             WHERE id = ? AND user_id = ? AND (name IS NOT ?1 OR site_url IS NOT ?2)`,
          )
          .bind(app.name, app.siteUrl, now, app.id, args.userId),
      );
    } else {
      statements.push(
        db
          .prepare(
            `INSERT INTO apps (id, user_id, connection_id, repo, name, slug, site_url, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          )
          .bind(
            app.id,
            args.userId,
            args.connectionId,
            nativeProjectRepo(app.id),
            app.name,
            await freeSlug(db, args.userId, app.name),
            app.siteUrl,
            now,
            now,
          ),
      );
    }
  }
  for (const id of known) {
    if (!listed.has(id)) {
      statements.push(db.prepare('DELETE FROM apps WHERE id = ? AND user_id = ?').bind(id, args.userId));
    }
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }
}

/** The person's apps in one account. */
export async function listAppsOf(db: D1Database, userId: string, connectionId: string): Promise<App[]> {
  const { results } = await db
    .prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE apps.user_id = ? AND apps.connection_id = ? ORDER BY apps.name`)
    .bind(userId, connectionId)
    .all<AppRow>();
  return results.map(toApp);
}

/** An app `userId` may read: their own (`owner`), or a public one (`public`). */
export async function findReadableApp(
  db: D1Database,
  ref: { id: string } | { owner: string; slug: string },
  userId: string,
): Promise<(App & { role: 'owner' | 'public' }) | null> {
  const row = await db
    .prepare(
      'id' in ref
        ? `SELECT ${APP_COLUMNS} FROM apps WHERE apps.id = ?1`
        : `SELECT ${APP_COLUMNS} FROM apps WHERE apps.slug = ?2 AND apps.user_id = (SELECT id FROM "user" WHERE username = ?1)`,
    )
    .bind(...('id' in ref ? [ref.id] : [ref.owner, ref.slug]))
    .first<AppRow>();
  if (!row) {
    return null;
  }
  if (row.user_id === userId) {
    return { ...toApp(row), role: 'owner' };
  }
  return row.visibility === 'public' ? { ...toApp(row), role: 'public' } : null;
}

/** Makes one of the person's own apps public or private; false when it isn't theirs. */
export async function setAppVisibility(
  db: D1Database,
  args: { userId: string; appId: string; visibility: ProjectVisibility },
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE apps SET visibility = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(args.visibility, Date.now(), args.appId, args.userId)
    .run();
  return result.meta.changes > 0;
}

/** Public apps, newest first, with their owner's name: what Explore shows beside public projects. */
export async function listPublicApps(db: D1Database, limit = 60): Promise<(App & { ownerName: string | null })[]> {
  const { results } = await db
    .prepare(
      `SELECT ${APP_COLUMNS}, (SELECT name FROM "user" WHERE "user".id = apps.user_id) AS owner_name FROM apps
       WHERE apps.visibility = 'public' ORDER BY apps.created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<AppRow & { owner_name: string | null }>();
  return results.map((row) => ({ ...toApp(row), ownerName: row.owner_name }));
}
