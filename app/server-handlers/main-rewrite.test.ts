import { afterEach, describe, expect, it, vi } from 'vitest';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { USER_WORKSPACE_IMAGE } from '~/lib/.server/cloudflare/user-workspace-image';
import { createCommandLineToken } from '~/lib/cloudflare/data/command-line-tokens.server';
import { ORG, teamFixture } from '~/test/project-fixture';
import { z } from 'zod';
import {
  latestMainChanges,
  listMainChanges,
  recordMainRewrite,
  recordProductionPublish,
} from '~/lib/cloudflare/data/org-projects.server';
import { commandLineRewriteMainAction, runtimeMainRewriteAction, runtimeMainRewrittenAction } from './main-rewrite';
import { listMyProjectsAction, listProjectMainChangesAction } from './projects';
import { runtimeMainPushedAction } from './runtime-projects';

const SITE = '55555555-5555-4555-8555-555555555555';
const MAIN = 'a'.repeat(40);
const SLIM = 'b'.repeat(40);
const OWNER_ONLY = 'Only the project’s owner, or one of its team’s admins, can rewrite its main.';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The team's project Storefront, which CloudChef deploys; its admin Ada has a runtime in the team's account. */
async function world() {
  const team = await teamFixture();
  team.database.exec(`
    INSERT INTO org_projects (id, connection_id, org_id, name, slug, artifact_repo, created_from, deploys_with, created_at)
      VALUES ('${SITE}', 'team-connection', '${ORG}', 'Storefront', 'storefront', 't-storefront', 'zip', 'cloudchef', 1);
  `);
  team.database
    .prepare(
      `INSERT INTO user_computer_runtimes (user_id, connection_id, connection_generation, worker_name, endpoint,
         runtime_version, image_digest, protocol_version, status, created_at, updated_at)
       VALUES (?, 'team-connection', 2, 'ada-runtime', 'https://ada.runtime.test', ?, ?, ?, 'ready', 1, 1)`,
    )
    .run(
      team.admin.userId,
      USER_WORKSPACE_RUNTIME_SHA256,
      USER_WORKSPACE_IMAGE,
      USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
    );
  const forwarded: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      forwarded.push({ url: String(input), body: JSON.parse(String(init?.body ?? 'null')) });
      return Response.json({ oldCommit: MAIN, newCommit: SLIM, publishedBy: 'cloudchef', recorded: true });
    }),
  );
  const tokens = {
    admin: (await createCommandLineToken(team.env.DB, team.admin.userId, 'Laptop')).token,
    sara: (await createCommandLineToken(team.env.DB, team.sara.userId, 'Laptop')).token,
  };
  const rewrite = (token: string, body: Record<string, string> = {}) =>
    commandLineRewriteMainAction({
      request: new Request('https://cloudchef.build/api/command-line/projects/rewrite-main', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ project: SITE, branch: 'slim', commit: SLIM, expected: MAIN, ...body }),
      }),
      env: team.env,
    });
  const rewrites = () =>
    team.database
      .prepare('SELECT project_id, rewritten_by, branch, old_commit, new_commit FROM project_main_rewrites')
      .all();
  return { ...team, forwarded, tokens, rewrite, rewrites };
}

describe('rewriting main from the command line', () => {
  it('goes to the runtime of the team admin who asks, with the commits they read', async () => {
    const { tokens, rewrite, forwarded } = await world();

    const answer = await rewrite(tokens.admin);

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ oldCommit: MAIN, newCommit: SLIM, publishedBy: 'cloudchef', recorded: true });
    expect(forwarded).toEqual([
      {
        url: 'https://ada.runtime.test/v1/projects/rewrite-main',
        body: { orgProjectId: SITE, branch: 'slim', commit: SLIM, expected: MAIN },
      },
    ]);
  });

  it('tells a member who may edit the project that only its owner can, and one who may not see it nothing', async () => {
    const { database, sara, tokens, rewrite, forwarded } = await world();

    expect((await rewrite(tokens.sara)).status).toBe(404);

    database
      .prepare(`INSERT INTO org_project_access (project_id, user_id, role, granted_at) VALUES (?, ?, 'edit', 1)`)
      .run(SITE, sara.userId);
    const refused = await rewrite(tokens.sara);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: OWNER_ONLY });
    expect(forwarded).toEqual([]);
  });

  it('is refused for main itself, or a commit that isn’t one', async () => {
    const { tokens, rewrite, forwarded } = await world();

    expect((await rewrite(tokens.admin, { branch: 'main' })).status).toBe(400);
    expect((await rewrite(tokens.admin, { expected: 'main' })).status).toBe(400);
    expect(forwarded).toEqual([]);
  });
});

describe('a runtime rewriting main', () => {
  it('learns the repository only for someone who runs the project, and records only their rewrite', async () => {
    const { runtime, env, admin, sara, database, rewrites } = await world();
    database
      .prepare(`INSERT INTO org_project_access (project_id, user_id, role, granted_at) VALUES (?, ?, 'edit', 1)`)
      .run(SITE, sara.userId);
    const asked = (userId: string) =>
      runtime('/api/cloudflare/runtime-projects/main-rewrite', { orgProjectId: SITE }, { userId }).then((request) =>
        runtimeMainRewriteAction({ request, env }),
      );
    const told = (userId: string) =>
      runtime(
        '/api/cloudflare/runtime-projects/main-rewritten',
        { orgProjectId: SITE, branch: 'slim', oldCommit: MAIN, newCommit: SLIM },
        { userId },
      ).then((request) => runtimeMainRewrittenAction({ request, env }));

    const refused = await asked(sara.userId);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: OWNER_ONLY });
    expect(await (await asked(admin.userId)).json()).toEqual({ repo: 't-storefront', deploysWith: 'cloudchef' });

    expect((await told(sara.userId)).status).toBe(403);
    expect(rewrites()).toEqual([]);
    expect((await told(admin.userId)).status).toBe(200);
    expect(rewrites()).toEqual([
      { project_id: SITE, rewritten_by: admin.userId, branch: 'slim', old_commit: MAIN, new_commit: SLIM },
    ]);
  });
});

describe('a runtime telling of a push to main', () => {
  it('records who pushed, for someone who may edit the project, and who last changed it', async () => {
    const { runtime, env, admin, sara, database } = await world();
    const told = (userId: string, body: Record<string, string | null>) =>
      runtime('/api/cloudflare/runtime-projects/main-pushed', { orgProjectId: SITE, ...body }, { userId }).then(
        (request) => runtimeMainPushedAction({ request, env }),
      );
    const pushes = () =>
      database.prepare('SELECT project_id, pushed_by, old_commit, new_commit FROM project_main_pushes').all();

    // Sara can't see the project, then may only view it.
    expect((await told(sara.userId, { oldCommit: MAIN, newCommit: SLIM })).status).toBe(403);
    database
      .prepare(`INSERT INTO org_project_access (project_id, user_id, role, granted_at) VALUES (?, ?, 'view', 1)`)
      .run(SITE, sara.userId);
    expect((await told(sara.userId, { oldCommit: MAIN, newCommit: SLIM })).status).toBe(403);
    expect(pushes()).toEqual([]);

    database.prepare(`UPDATE org_project_access SET role = 'edit' WHERE user_id = ?`).run(sara.userId);
    vi.useFakeTimers({ toFake: ['Date'], now: 10_000 });
    expect((await told(sara.userId, { oldCommit: null, newCommit: MAIN })).status).toBe(200);
    vi.setSystemTime(20_000);
    expect((await told(admin.userId, { oldCommit: MAIN, newCommit: SLIM })).status).toBe(200);
    vi.useRealTimers();
    expect(pushes()).toEqual([
      { project_id: SITE, pushed_by: sara.userId, old_commit: null, new_commit: MAIN },
      { project_id: SITE, pushed_by: admin.userId, old_commit: MAIN, new_commit: SLIM },
    ]);
    expect((await told(admin.userId, { oldCommit: MAIN, newCommit: 'main' })).status).toBe(400);

    expect((await latestMainChanges(env.DB, [SITE])).get(SITE)?.by).toBe('ada');
    // A rewrite after it is the newest change.
    await recordMainRewrite(env.DB, {
      projectId: SITE,
      userId: sara.userId,
      branch: 'slim',
      oldCommit: SLIM,
      newCommit: MAIN,
      rewrittenAt: 30_000,
    });
    expect((await latestMainChanges(env.DB, [SITE])).get(SITE)?.by).toBe('sara.a');
    expect((await latestMainChanges(env.DB, [])).size).toBe(0);

    // Ada's projects list says who last changed it.
    const list = await listMyProjectsAction({
      request: new Request('https://cloudchef.build/api/org-projects', { headers: { cookie: admin.cookie } }),
      env,
    });
    const listed = z
      .object({ projects: z.array(z.object({ id: z.string(), lastChange: z.object({ by: z.string() }).nullable() })) })
      .parse(await list.json());
    expect(listed.projects.find((project) => project.id === SITE)?.lastChange?.by).toBe('sara.a');

    // The whole record, newest first, pushes and rewrites alike, and a page of it before a time.
    const changes = await listMainChanges(env.DB, SITE, { limit: 10 });
    expect(changes).toEqual([
      {
        kind: 'rewrite',
        by: { id: sara.userId, name: 'sara.a' },
        oldCommit: SLIM,
        newCommit: MAIN,
        branch: 'slim',
        at: 30_000,
      },
      {
        kind: 'push',
        by: { id: admin.userId, name: 'ada' },
        oldCommit: MAIN,
        newCommit: SLIM,
        branch: null,
        at: 20_000,
      },
      {
        kind: 'push',
        by: { id: sara.userId, name: 'sara.a' },
        oldCommit: null,
        newCommit: MAIN,
        branch: null,
        at: 10_000,
      },
    ]);
    expect(await listMainChanges(env.DB, SITE, { limit: 1, before: 30_000 })).toEqual([changes[1]]);

    // Anyone who may view the project reads it; anyone else is told there's no such project.
    const read = (cookie: string) =>
      listProjectMainChangesAction({
        request: new Request(`https://cloudchef.build/api/projects/${SITE}/main-changes?limit=2`, {
          headers: { cookie },
        }),
        env,
      });
    database.prepare(`UPDATE org_project_access SET role = 'view' WHERE user_id = ?`).run(sara.userId);
    const viewed = await read(sara.cookie);
    expect(viewed.status).toBe(200);
    expect(await viewed.json()).toEqual({ changes: changes.slice(0, 2), publishes: {} });
    database.prepare('DELETE FROM org_project_access WHERE user_id = ?').run(sara.userId);
    expect((await read(sara.cookie)).status).toBe(404);
  });

  it('records the pushed commit going live once, with who pushed it and the site', async () => {
    const { runtime, env, admin, database } = await world();
    await runtimeMainPushedAction({
      request: await runtime(
        '/api/cloudflare/runtime-projects/main-pushed',
        { orgProjectId: SITE, oldCommit: MAIN, newCommit: SLIM },
        { userId: admin.userId },
      ),
      env,
    });
    const publish = {
      projectId: SITE,
      commit: SLIM,
      siteUrl: 'https://site.ada.workers.dev',
      siteFrameable: true,
      publishedAt: 40_000,
      deployedBy: 'cloudchef' as const,
    };
    expect(await recordProductionPublish(env.DB, publish)).toEqual({ ...publish, pushedBy: admin.userId });
    expect(await recordProductionPublish(env.DB, publish)).toBeNull();
    expect(database.prepare('SELECT site_url FROM org_projects WHERE id = ?').get(SITE)).toEqual({
      site_url: 'https://site.ada.workers.dev',
    });
    // A commit never pushed through CloudChef: CloudChef's own deploy of it counts, Workers Builds' status doesn't.
    expect(
      await recordProductionPublish(env.DB, { ...publish, commit: MAIN, deployedBy: 'workers_builds' }),
    ).toBeNull();
    expect(await recordProductionPublish(env.DB, { ...publish, commit: 'c'.repeat(40) })).toMatchObject({
      pushedBy: null,
    });
  });
});
