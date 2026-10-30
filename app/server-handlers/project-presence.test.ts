import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ORG, ORIGIN, teamFixture, type Body } from '~/test/project-fixture';
import { recordMainPush } from '~/lib/cloudflare/data/org-projects.server';
import { pruneProjectVisits } from '~/lib/cloudflare/data/project-presence.server';
import type { WorkersBuild } from '~/lib/.server/cloudflare/user-account-api';
import type { WorkersBuildsAccountApi } from '~/lib/.server/cloudflare/workers-builds';
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

/** The team's project Storefront, which Workers Builds publishes as the Worker tagged `storefront-tag`. */
async function world() {
  const team = await teamFixture();
  team.database.exec(`
    INSERT INTO org_projects (id, connection_id, org_id, name, slug, artifact_repo, created_from, deploys_with,
        workers_builds_script_tag, created_at)
      VALUES ('${SITE}', 'team-connection', '${ORG}', 'Storefront', 'storefront', 't-storefront', 'zip',
        'workers_builds', 'storefront-tag', 1);
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
      body: { here: [], changedSince: null },
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
  it('says which of main’s commits is live, which were, and which are publishing or failed, from Workers Builds', async () => {
    const { env, admin } = await world();
    const build = (commit: string, createdOn: string, status: string, outcome: string | null): WorkersBuild => ({
      id: `${commit[0]}-${createdOn}`,
      status,
      outcome,
      branch: 'main',
      commit,
      createdOn,
      repository: null,
    });
    const asked: string[] = [];
    const api: WorkersBuildsAccountApi = {
      listWorkersBuilds: async (tag) => {
        asked.push(tag);
        return [
          build(MAIN, '2026-10-01T00:00:00Z', 'stopped', 'success'),
          build(LAST, '2026-10-03T00:00:00Z', 'running', null),
          build(NEXT, '2026-10-02T00:00:00Z', 'stopped', 'success'),
          { ...build('d'.repeat(40), '2026-10-04T00:00:00Z', 'stopped', 'success'), branch: 'preview' },
        ];
      },
      listWorkerScripts: async () => [],
      latestWorkersBuilds: async () => new Map(),
      listWorkersBuildTriggers: async () => [],
      listWorkerPreviews: async () => [],
      workerAddresses: async () => ({ customDomains: [], workersDevUrl: null }),
    };
    const read = (query = '') =>
      listProjectMainChangesAction({
        request: new Request(`${ORIGIN}/api/projects/${SITE}/main-changes${query}`, {
          headers: { cookie: admin.cookie },
        }),
        env,
        openAccount: async () => api,
      }).then((response) => response.json());

    expect(await read()).toEqual({
      changes: [],
      publishes: { [LAST]: 'publishing', [NEXT]: 'live', [MAIN]: 'published' },
    });
    expect(asked).toEqual(['storefront-tag']);
    // A later page doesn't ask again.
    expect(await read('?before=5')).toEqual({ changes: [], publishes: {} });
    expect(asked).toHaveLength(1);
  });
});
