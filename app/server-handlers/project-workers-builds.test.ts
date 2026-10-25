import { describe, expect, it } from 'vitest';
import { ORG, teamFixture } from '~/test/project-fixture';
import type { WorkersBuildsAccountApi } from '~/lib/.server/cloudflare/workers-builds';
import type { WorkersBuildRepository } from '~/lib/.server/cloudflare/user-account-api';
import { projectRoute, switchProjectWorkersBuildsAction } from './projects';

const SITE = '11111111-1111-4111-8111-111111111111';
const TAG = 'f'.repeat(32);

/** Workers Builds with one Worker, `forbidden-feminine`, whose triggers build from `repository`. */
function workersBuilds(repository: WorkersBuildRepository) {
  const api: WorkersBuildsAccountApi = {
    listWorkerScripts: async () => [{ tag: TAG, name: 'forbidden-feminine' }],
    latestWorkersBuilds: async () => new Map(),
    listWorkersBuilds: async () => [],
    listWorkersBuildTriggers: async () => [
      {
        id: 'trigger',
        name: 'production',
        buildCommand: 'pnpm run workers-builds:build',
        deployCommand: 'npx cf deploy --prebuilt',
        rootDirectory: '/',
        branchIncludes: ['master'],
        branchExcludes: [],
        repository,
      },
    ],
    listWorkerPreviews: async () => [],
    workerAddresses: async () => ({ customDomains: [], workersDevUrl: null }),
  };
  return async () => api;
}

const GITHUB: WorkersBuildRepository = {
  provider: 'github',
  repoId: '1115484475',
  repoName: 'forbidden-feminine',
  accountId: '1',
  accountName: 'ada',
};

describe("switching a project's Workers Builds to Artifacts", () => {
  it('routes a path naming a project by its pattern', () => {
    expect(projectRoute(`/api/projects/${SITE}/workers-builds/switch`)).toBe(
      '/api/projects/:projectId/workers-builds/switch',
    );
    expect(projectRoute('/api/projects/import')).toBeNull();
  });

  it('says how to move a Worker built from GitHub, says when it is done, and lets only an admin ask', async () => {
    const { database, env, admin, sara, browser } = await teamFixture();
    database
      .prepare(
        `INSERT INTO org_projects (id, connection_id, org_id, name, import_repo_id, import_repo_full_name, import_branch,
           workers_builds_script_tag, origin, created_at)
         VALUES (?, 'team-connection', ?, 'ff', 1115484475, 'ada/forbidden-feminine', 'master', ?, 'imported', 1)`,
      )
      .run(SITE, ORG, TAG);
    const ask = (cookie: string, openAccount = workersBuilds(GITHUB)) =>
      switchProjectWorkersBuildsAction({
        request: browser(cookie, `/api/projects/${SITE}/workers-builds/switch`, {}),
        env,
        openAccount,
      });

    expect(await (await ask(admin.cookie)).json()).toEqual({
      instruction: expect.stringContaining('Open the project once first'),
    });
    database.prepare(`UPDATE org_projects SET artifact_repo = 't-${SITE}'`).run();
    const instructed = await ask(admin.cookie);
    expect(instructed.status).toBe(200);
    expect(await instructed.json()).toEqual({
      instruction: expect.stringMatching(
        /forbidden-feminine.*namespace cloudchef and the repository t-1111.*from main/,
      ),
      url: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages',
    });
    const switched = await ask(
      admin.cookie,
      workersBuilds({ provider: 'artifacts', repoId: 'r', repoName: `t-${SITE}`, accountId: null, accountName: null }),
    );
    expect(await switched.json()).toEqual({ switched: true });
    expect((await ask(sara.cookie)).status).toBe(404);
  });
});
