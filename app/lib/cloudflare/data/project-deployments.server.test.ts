import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import {
  claimDeployment,
  DEPLOYMENT_LEASE_MS,
  deployToWantedWorker,
  latestDeployments,
  reportDeployment,
  retryDeployment,
} from './project-deployments.server';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ONE = 'a'.repeat(40);
const TWO = 'b'.repeat(40);

/** A personal connection with one uploaded project, which CloudChef deploys. */
function setup() {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('ada', 'Ada', 'ada@example.com', 1, 1, 1);
    INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
      VALUES ('own', 'ada', 'account', 'active', 1, 1);
    INSERT INTO org_projects (id, connection_id, name, artifact_repo, created_from, created_at)
      VALUES ('${PROJECT}', 'own', 'Glossary', 't-${PROJECT}', 'zip', 1);
  `);
  return { database, db };
}

const claim = (db: D1Database, branch: string, commit: string, now: number) =>
  claimDeployment(db, { projectId: PROJECT, branch, commit, defaultBranch: 'main', userId: 'ada', now });

describe('project deployments', () => {
  it('marks an upload, and one the old Worker adds during rollout, as deployed by CloudChef', () => {
    const { database } = setup();
    database.exec(`INSERT INTO org_projects (id, connection_id, name, artifact_repo, created_from, created_at)
      VALUES ('later', 'own', 'Later', 't-later', 'zip', 2)`);
    expect(database.prepare('SELECT id, deploys_with FROM org_projects ORDER BY id').all()).toEqual([
      { id: PROJECT, deploys_with: 'cloudchef' },
      { id: 'later', deploys_with: 'cloudchef' },
    ]);
  });

  it('claims a commit once, and a newer one of the same branch supersedes it', async () => {
    const { db } = setup();
    const first = await claim(db, 'main', ONE, 1_000);
    expect(first).toMatchObject({ claimed: true, deployment: { kind: 'production', state: 'queued', commit: ONE } });
    expect((await claim(db, 'main', ONE, 2_000)).claimed).toBe(false);

    const second = await claim(db, 'main', TWO, 3_000);
    expect(second.claimed).toBe(true);
    expect(await reportDeployment(db, { id: first.deployment.id, userId: 'ada', state: 'building', now: 4_000 })).toBe(
      'superseded',
    );
    // A preview of another branch is its own line of work.
    expect((await claim(db, 'feature', ONE, 5_000)).deployment.kind).toBe('preview');
    expect((await latestDeployments(db, PROJECT)).map((row) => [row.branch, row.state])).toEqual([
      ['feature', 'queued'],
      ['main', 'queued'],
      ['main', 'superseded'],
    ]);
  });

  it('lets one deploy of a project run at a time, and records how it ended', async () => {
    const { db } = setup();
    const main = (await claim(db, 'main', ONE, 1_000)).deployment;
    const preview = (await claim(db, 'feature', TWO, 1_000)).deployment;
    expect(await reportDeployment(db, { id: main.id, userId: 'ada', state: 'deploying', now: 2_000 })).toBe('recorded');
    // The other waits its turn.
    expect(await reportDeployment(db, { id: preview.id, userId: 'ada', state: 'deploying', now: 2_500 })).toBe('busy');
    // Once the first deploy's lease has run out, the other may go.
    expect(
      await reportDeployment(db, {
        id: preview.id,
        userId: 'ada',
        state: 'deploying',
        now: 2_000 + DEPLOYMENT_LEASE_MS + 1,
      }),
    ).toBe('recorded');
    expect(
      await reportDeployment(db, {
        id: main.id,
        userId: 'ada',
        state: 'succeeded',
        url: 'https://glossary.ada.workers.dev',
        workerName: 'glossary',
      }),
    ).toBe('recorded');
    expect(await reportDeployment(db, { id: main.id, userId: 'ada', state: 'failed' })).toBe('refused');
    expect((await latestDeployments(db, PROJECT)).find((row) => row.id === main.id)).toMatchObject({
      state: 'succeeded',
      url: 'https://glossary.ada.workers.dev',
      workerName: 'glossary',
    });
  });

  it('is reported only by the runtime that claimed it, and a failure keeps its stage and reason', async () => {
    const { db } = setup();
    const main = (await claim(db, 'main', ONE, 1_000)).deployment;
    expect(await reportDeployment(db, { id: main.id, userId: 'someone-else', state: 'building' })).toBe('refused');
    expect(
      await reportDeployment(db, {
        id: main.id,
        userId: 'ada',
        state: 'failed',
        failureStage: 'build',
        reason: 'The build script failed: tsc found 3 errors.',
      }),
    ).toBe('recorded');
    const [failed] = await latestDeployments(db, PROJECT);
    expect(failed).toMatchObject({ state: 'failed', failureStage: 'build' });

    const retried = await retryDeployment(db, { id: main.id, userId: 'ada' });
    expect(retried).toMatchObject({ state: 'queued', attempt: 2, failureStage: null, reason: null });
    // A newer commit makes the old one not worth trying again.
    await reportDeployment(db, { id: main.id, userId: 'ada', state: 'failed', failureStage: 'build' });
    await claim(db, 'main', TWO, 9_000);
    expect(await retryDeployment(db, { id: main.id, userId: 'ada' })).toBeNull();
  });

  it('deploys a project that went to a derived name again to the Worker its config names, once that is free', async () => {
    const { database, db } = setup();
    const { deployment } = await claim(db, 'main', ONE, 1_000);
    await reportDeployment(db, { id: deployment.id, userId: 'ada', state: 'deploying', now: 2_000 });
    await reportDeployment(db, {
      id: deployment.id,
      userId: 'ada',
      state: 'succeeded',
      workerName: 'glossary-1111',
      wantedWorkerName: 'glossary',
      now: 3_000,
    });
    database.exec(`UPDATE org_projects SET deploy_worker_name = 'glossary-1111' WHERE id = '${PROJECT}'`);
    // Another project of the account already deploys as that Worker: refused, and nothing changes.
    database.exec(`INSERT INTO org_projects (id, connection_id, name, artifact_repo, created_from, created_at,
      deploy_worker_name) VALUES ('other', 'own', 'Other', 't-other', 'zip', 2, 'glossary')`);
    expect(await deployToWantedWorker(db, { id: deployment.id, projectId: PROJECT, userId: 'ada', now: 4_000 })).toBe(
      null,
    );
    expect((await latestDeployments(db, PROJECT))[0]).toMatchObject({ state: 'succeeded', attempt: 1 });

    database.exec(`DELETE FROM org_projects WHERE id = 'other'`);
    expect(
      await deployToWantedWorker(db, { id: deployment.id, projectId: PROJECT, userId: 'ada', now: 5_000 }),
    ).toMatchObject({ state: 'queued', attempt: 2, workerName: null, wantedWorkerName: null });
    expect(database.prepare('SELECT deploy_worker_name FROM org_projects WHERE id = ?').get(PROJECT)).toEqual({
      deploy_worker_name: 'glossary',
    });
    // Once switched, it isn't offered again.
    expect(await deployToWantedWorker(db, { id: deployment.id, projectId: PROJECT, userId: 'ada', now: 6_000 })).toBe(
      null,
    );
  });

  it('lets a superseded deploy finish before the newer one deploys, and takes over work whose runtime stopped', async () => {
    const { db } = setup();
    const older = (await claim(db, 'main', ONE, 1_000)).deployment;
    await reportDeployment(db, { id: older.id, userId: 'ada', state: 'deploying', now: 2_000 });
    const newer = (await claim(db, 'main', TWO, 3_000)).deployment;
    expect(await reportDeployment(db, { id: newer.id, userId: 'ada', state: 'deploying', now: 4_000 })).toBe('busy');
    // Once the older one stops, the newer goes ahead at once.
    expect(await reportDeployment(db, { id: older.id, userId: 'ada', state: 'failed', now: 5_000 })).toBe('superseded');
    expect(await reportDeployment(db, { id: newer.id, userId: 'ada', state: 'deploying', now: 6_000 })).toBe(
      'recorded',
    );

    // Its runtime stops: a claim after the lease ran out takes it over, as a new attempt.
    expect((await claim(db, 'main', TWO, 7_000)).claimed).toBe(false);
    const taken = await claim(db, 'main', TWO, 6_000 + DEPLOYMENT_LEASE_MS + 1);
    expect(taken).toMatchObject({ claimed: true, deployment: { state: 'queued', attempt: 2 } });
  });

  it('refuses the claim of a head read before a newer commit was claimed', async () => {
    const { db } = setup();
    await claim(db, 'main', TWO, 2_000);
    const stale = await claimDeployment(db, {
      projectId: PROJECT,
      branch: 'main',
      commit: ONE,
      defaultBranch: 'main',
      userId: 'ada',
      notBefore: 1_500,
      now: 3_000,
    });
    expect(stale.claimed).toBe(false);
    expect((await latestDeployments(db, PROJECT)).map((row) => row.commit)).toEqual([TWO]);
  });
});
