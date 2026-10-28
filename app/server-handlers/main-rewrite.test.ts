import { afterEach, describe, expect, it, vi } from 'vitest';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { USER_WORKSPACE_SANDBOX_BASE_IMAGE } from '~/workflows/user-workspace-runtime-provisioning';
import { createCommandLineToken } from '~/lib/cloudflare/data/command-line-tokens.server';
import { ORG, teamFixture } from '~/test/project-fixture';
import { commandLineRewriteMainAction, runtimeMainRewriteAction, runtimeMainRewrittenAction } from './main-rewrite';

const SITE = '55555555-5555-4555-8555-555555555555';
const MAIN = 'a'.repeat(40);
const SLIM = 'b'.repeat(40);
const OWNER_ONLY = 'Only the project’s owner, or one of its team’s admins, can rewrite its main.';

afterEach(() => {
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
      USER_WORKSPACE_SANDBOX_BASE_IMAGE,
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
