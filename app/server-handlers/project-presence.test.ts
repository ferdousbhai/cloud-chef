import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ORG, ORIGIN, teamFixture, type Body } from '~/test/project-fixture';
import { recordMainPush } from '~/lib/cloudflare/data/org-projects.server';
import { pruneProjectVisits } from '~/lib/cloudflare/data/project-presence.server';
import { projectPresenceAction } from './project-presence';
import { listProjectMainChangesAction } from './projects';

const SITE = '55555555-5555-4555-8555-555555555555';
const MAIN = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const LAST = 'c'.repeat(40);

const answerSchema = z.looseObject({ here: z.array(z.unknown()).optional(), changedSince: z.unknown().optional() });

afterEach(() => {
  vi.useRealTimers();
});

/** The project Storefront. */
async function world() {
  const team = await teamFixture();
  team.database.exec(`
    INSERT INTO org_projects (id, connection_id, org_id, name, slug, artifact_repo, created_from, created_at)
      VALUES ('${SITE}', 'team-connection', '${ORG}', 'Storefront', 'storefront', 't-storefront', 'zip', 1);
  `);
  const report = async (cookie: string, body: Body) => {
    const response = await projectPresenceAction({
      request: team.browser(cookie, `/api/projects/${SITE}/presence`, body),
      env: team.env,
    });
    return { status: response.status, body: answerSchema.parse(await response.json()) };
  };
  const grant = (userId: string, role: 'view' | 'edit') =>
    team.database
      .prepare(`INSERT INTO org_project_access (project_id, user_id, role, granted_at) VALUES (?, ?, ?, 1)`)
      .run(SITE, userId, role);
  return { ...team, report, grant };
}

describe('who has a project open', () => {
  it('shows each person who may view it the others there now, and whether their agent is working', async () => {
    const { admin, sara, report, grant } = await world();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);

    // Sara may not see the project yet: she can't report, and isn't shown.
    expect((await report(sara.cookie, { working: false })).status).toBe(404);
    expect(await report(admin.cookie, { working: true })).toEqual({
      status: 200,
      body: { here: [], changedSince: null, canShare: true },
    });

    grant(sara.userId, 'view');
    expect((await report(sara.cookie, { working: false })).body.here).toEqual([
      { id: admin.userId, name: 'ada', image: null, working: true },
    ]);
    expect((await report(admin.cookie, { working: false })).body.here).toEqual([
      { id: sara.userId, name: 'sara.a', image: null, working: false },
    ]);

    // Ninety seconds without a report and she has gone; closing the project says so at once.
    vi.setSystemTime(1_000_000 + 90_001);
    expect((await report(admin.cookie, { working: false })).body.here).toEqual([]);
    await report(sara.cookie, { working: false });
    await report(sara.cookie, { working: false, leaving: true });
    expect((await report(admin.cookie, { working: false })).body.here).toEqual([]);
  });

  it('tells someone coming back what others changed since they were last here, once', async () => {
    const { env, admin, sara, report, grant } = await world();
    grant(sara.userId, 'edit');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    expect((await report(admin.cookie, { working: false })).body.changedSince).toBeNull();
    await report(admin.cookie, { working: false, leaving: true });

    await recordMainPush(env.DB, {
      projectId: SITE,
      userId: sara.userId,
      oldCommit: null,
      newCommit: MAIN,
      pushedAt: 1_100_000,
    });
    await recordMainPush(env.DB, {
      projectId: SITE,
      userId: admin.userId,
      oldCommit: MAIN,
      newCommit: NEXT,
      pushedAt: 1_150_000,
    });
    await recordMainPush(env.DB, {
      projectId: SITE,
      userId: sara.userId,
      oldCommit: NEXT,
      newCommit: LAST,
      pushedAt: 1_200_000,
    });

    vi.setSystemTime(1_300_000);
    // Ada's own push isn't news to her.
    expect((await report(admin.cookie, { working: false })).body.changedSince).toEqual({
      count: 2,
      people: ['sara.a'],
      latestAt: 1_200_000,
    });
    // The visit goes on: not told again.
    vi.setSystemTime(1_330_000);
    expect((await report(admin.cookie, { working: false })).body.changedSince).toBeNull();
  });

  it('refuses a report from another site or of anything else', async () => {
    const { env, admin, report } = await world();
    const foreign = await projectPresenceAction({
      request: new Request(`${ORIGIN}/api/projects/${SITE}/presence`, {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ working: false }),
      }),
      env,
    });
    expect(foreign.status).toBe(403);
    expect((await report(admin.cookie, { working: 'yes' })).status).toBe(400);
  });

  it('forgets visits not made for half a year', async () => {
    const { env, database, admin, report } = await world();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    await report(admin.cookie, { working: false });
    await pruneProjectVisits(env.DB, 1_000_000 + 179 * 24 * 60 * 60_000);
    expect(database.prepare('SELECT COUNT(*) AS n FROM project_visits').get()).toEqual({ n: 1 });
    await pruneProjectVisits(env.DB, 1_000_000 + 181 * 24 * 60 * 60_000);
    expect(database.prepare('SELECT COUNT(*) AS n FROM project_visits').get()).toEqual({ n: 0 });
  });
});

describe("a project's record of what went live", () => {
  it('says which of main’s commits is live, which were, and which are publishing, from its publishes', async () => {
    const { env, admin, database } = await world();
    const publish = (id: string, branch: string, commit: string, state: string, at: number) =>
      database
        .prepare(
          `INSERT INTO project_deployments (id, project_id, kind, branch, commit_sha, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, SITE, branch === 'main' ? 'production' : 'preview', branch, commit, state, at, at);
    publish('d1', 'main', MAIN, 'succeeded', 1);
    publish('d2', 'main', NEXT, 'succeeded', 2);
    publish('d3', 'main', LAST, 'building', 3);
    publish('d4', 'idea', 'd'.repeat(40), 'succeeded', 4);
    const read = (query = '') =>
      listProjectMainChangesAction({
        request: new Request(`${ORIGIN}/api/projects/${SITE}/main-changes${query}`, {
          headers: { cookie: admin.cookie },
        }),
        env,
      }).then((response) => response.json());

    expect(await read()).toEqual({
      changes: [],
      publishes: { [LAST]: 'publishing', [NEXT]: 'live', [MAIN]: 'published' },
    });
    // A later page says nothing of publishes again.
    expect(await read('?before=5')).toEqual({ changes: [], publishes: {} });
  });
});
