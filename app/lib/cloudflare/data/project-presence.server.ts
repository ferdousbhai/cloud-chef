/**
 * Who has a project open right now, and what changed since someone last had it open. Only metadata is kept
 * (`project_visits`: a person, a project, when they were last seen, and whether their agent is working), never
 * anything they wrote or said: their chats stay in their own account's workspace.
 */

/** How long one report keeps someone here: a browser reports every 30 seconds, so three missed reports and they have gone. */
const PRESENCE_EXPIRY_MS = 90_000;
/** How long a person's last visit to a project is remembered, for "changed since you were last here". */
const VISIT_RETENTION_MS = 180 * 24 * 60 * 60_000;

/** Someone with the project open now; `working` while their agent is running a turn. */
export type ProjectVisitor = { id: string; name: string; image: string | null; working: boolean };

/** What others changed in a project's main since a time: how many changes, by whom (newest first), and the newest's time. */
export type ChangesSince = { count: number; people: string[]; latestAt: number };

/**
 * Records that `userId` has the project open at `now`, and returns when their previous visit ended (their last
 * report then), when this report begins a new visit: null while the visit goes on, and for a first visit.
 */
export async function recordVisit(
  db: D1Database,
  visit: { projectId: string; userId: string; working: boolean; now: number },
): Promise<{ previousVisitAt: number | null }> {
  // Two tabs reporting at once can both read the visit before either writes it; both then tell of the same changes.
  const row = await db
    .prepare('SELECT last_seen_at, here_until FROM project_visits WHERE project_id = ? AND user_id = ?')
    .bind(visit.projectId, visit.userId)
    .first<{ last_seen_at: number; here_until: number }>();
  await db
    .prepare(
      `INSERT INTO project_visits (project_id, user_id, last_seen_at, here_until, working) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (project_id, user_id) DO UPDATE
       SET last_seen_at = excluded.last_seen_at, here_until = excluded.here_until, working = excluded.working`,
    )
    .bind(visit.projectId, visit.userId, visit.now, visit.now + PRESENCE_EXPIRY_MS, visit.working ? 1 : 0)
    .run();
  return { previousVisitAt: row && row.here_until <= visit.now ? row.last_seen_at : null };
}

/** `userId` closed the project: they're no longer here, and this is when they were last. */
export async function leaveProject(db: D1Database, visit: { projectId: string; userId: string }): Promise<void> {
  await db
    .prepare('UPDATE project_visits SET here_until = 0, working = 0 WHERE project_id = ? AND user_id = ?')
    .bind(visit.projectId, visit.userId)
    .run();
}

/** Who has the project open at `now`, by name. */
export async function listVisitors(db: D1Database, projectId: string, now: number): Promise<ProjectVisitor[]> {
  const { results } = await db
    .prepare(
      `SELECT people.id, people.name, people.image, visits.working
       FROM project_visits AS visits JOIN "user" AS people ON people.id = visits.user_id
       WHERE visits.project_id = ? AND visits.here_until > ?
       ORDER BY people.name, people.id`,
    )
    .bind(projectId, now)
    .all<{ id: string; name: string; image: string | null; working: number }>();
  return results.map((row) => ({ id: row.id, name: row.name, image: row.image, working: row.working === 1 }));
}

/**
 * What people other than `userId` changed in the project's main after `since`: its pushes and rewrites, as the
 * runtimes reported them. Null when nobody else changed it. A change by someone no longer on CloudChef counts,
 * without a name.
 */
export async function changesSince(
  db: D1Database,
  args: { projectId: string; userId: string; since: number },
): Promise<ChangesSince | null> {
  const { results } = await db
    .prepare(
      `SELECT changes.changed_by, changes.changed_at, people.name FROM (
         SELECT pushed_by AS changed_by, pushed_at AS changed_at FROM project_main_pushes
         WHERE project_id = ?1 AND pushed_at > ?3
         UNION ALL
         SELECT rewritten_by, rewritten_at FROM project_main_rewrites WHERE project_id = ?1 AND rewritten_at > ?3
       ) AS changes
       LEFT JOIN "user" AS people ON people.id = changes.changed_by
       WHERE changes.changed_by IS NULL OR changes.changed_by <> ?2
       ORDER BY changes.changed_at DESC`,
    )
    .bind(args.projectId, args.userId, args.since)
    .all<{ changed_by: string | null; changed_at: number; name: string | null }>();
  if (results.length === 0) {
    return null;
  }
  const people = [...new Set(results.flatMap((row) => (row.name === null ? [] : [row.name])))];
  return { count: results.length, people, latestAt: results[0].changed_at };
}

/** Forgets visits nobody has made for `VISIT_RETENTION_MS`; someone here now is never among them. */
export async function pruneProjectVisits(db: D1Database, now: number): Promise<void> {
  await db
    .prepare('DELETE FROM project_visits WHERE last_seen_at < ?')
    .bind(now - VISIT_RETENTION_MS)
    .run();
}

export async function pruneProjectVisitsBestEffort(db: D1Database, now: number): Promise<void> {
  try {
    await pruneProjectVisits(db, now);
  } catch {
    console.error('Unable to prune old project visits');
  }
}
