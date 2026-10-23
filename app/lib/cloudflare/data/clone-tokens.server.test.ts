import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';
import { userWorkspaceDatabase } from '~/test/control-plane-d1';
import { fakeArtifacts } from '~/test/fake-artifacts';
import { cloneToken, sweepCloneTokens } from './clone-tokens.server';

const TEAM_PROJECT = '11111111-1111-4111-8111-111111111111';
const YEAR_FROM_NOW = Date.now() + 365 * 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const { database, db } = userWorkspaceDatabase();
  const artifacts = fakeArtifacts();
  const store = new ProjectRepositories(artifacts, { fetch: artifacts.fetch });
  let issued = 0;
  const readAccess = vi.spyOn(store, 'readAccess').mockImplementation(async () => {
    issued += 1;
    return {
      remote: 'https://artifacts.test/git/cloudchef/t-1.git',
      tokenId: `token-${issued}`,
      token: `secret-${issued}`,
      expiresAt: new Date(YEAR_FROM_NOW).toISOString(),
    };
  });
  const revokeToken = vi.spyOn(store, 'revokeToken').mockResolvedValue(undefined);
  const env = {
    DB: db,
    ARTIFACTS: artifacts,
    CLOUDCHEF_USER_RUNTIME: '1',
    CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://cloudchef.build',
    CONTROL_PLANE_SECRET: 'runtime-secret-that-is-long-enough',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    CLOUDCHEF_USER_ID: 'user-1',
    CLOUDCHEF_CONNECTION_ID: 'connection-1',
    CLOUDCHEF_CONNECTION_GENERATION: '3',
  };
  return { database, db, store, readAccess, revokeToken, env };
}

/** The control plane answers the runtime's project calls with `status`. */
function controlPlaneAnswers(status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      status === 200
        ? Response.json({ orgProjectId: TEAM_PROJECT, name: 'Site', repo: 't-1', defaultBranch: 'main', role: 'view' })
        : Response.json({ error: 'no' }, { status }),
    ),
  );
}

describe("a person's clone token", () => {
  it('is the same one each time while it lasts, and a new one once it has expired', async () => {
    const { database, db, store, readAccess } = setup();
    const args = { repo: 't-1', userId: 'user-1', orgProjectId: TEAM_PROJECT };

    const first = await cloneToken(db, store, args);
    expect(await cloneToken(db, store, args)).toEqual(first);
    expect(readAccess).toHaveBeenCalledTimes(1);

    database.prepare('UPDATE clone_tokens SET expires_at = 1').run();
    expect(await cloneToken(db, store, args)).toMatchObject({ token: 'secret-2' });
    // Another person's is their own.
    expect(await cloneToken(db, store, { ...args, userId: 'user-2' })).toMatchObject({ token: 'secret-3' });
  });

  it('is revoked once the person loses the team project, and kept while they have it', async () => {
    for (const [status, revoked] of [
      [200, false],
      [503, false],
      [401, true],
      [403, true],
      [404, true],
    ] as const) {
      const { database, db, store, revokeToken, env } = setup();
      await cloneToken(db, store, { repo: 't-1', userId: 'user-1', orgProjectId: TEAM_PROJECT });
      await cloneToken(db, store, { repo: 'p-own', userId: 'user-1', orgProjectId: null });
      controlPlaneAnswers(status);

      await sweepCloneTokens(env, store);

      expect(revokeToken.mock.calls).toEqual(revoked ? [['t-1', 'token-1']] : []);
      expect(database.prepare('SELECT repo FROM clone_tokens ORDER BY repo').all()).toEqual(
        revoked ? [{ repo: 'p-own' }] : [{ repo: 'p-own' }, { repo: 't-1' }],
      );
    }
  });

  it('is forgotten once it has expired', async () => {
    const { database, db, store, env } = setup();
    await cloneToken(db, store, { repo: 'p-own', userId: 'user-1', orgProjectId: null });
    database.prepare('UPDATE clone_tokens SET expires_at = 1').run();
    controlPlaneAnswers(200);
    await sweepCloneTokens(env, store);
    expect(database.prepare('SELECT repo FROM clone_tokens').all()).toEqual([]);
  });
});
