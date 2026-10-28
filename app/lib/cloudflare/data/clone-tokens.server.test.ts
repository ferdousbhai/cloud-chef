import { describe, expect, it } from 'vitest';
import { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';
import { userWorkspaceDatabase } from '~/test/control-plane-d1';
import { fakeArtifacts } from '~/test/fake-artifacts';
import { revokeRecordedCloneTokens } from './clone-tokens.server';

describe('clone tokens recorded before Clone used CloudChef’s git address', () => {
  it('are each revoked and forgotten, whatever project they read and whoever had them', async () => {
    const { database, db } = userWorkspaceDatabase();
    const artifacts = fakeArtifacts();
    await artifacts.create('t-1');
    const store = new ProjectRepositories(artifacts, { fetch: artifacts.fetch });
    database.exec(`
      INSERT INTO clone_tokens (repo, user_id, org_project_id, token_id, secret, remote, expires_at) VALUES
        ('t-1', 'user-1', '11111111-1111-4111-8111-111111111111', 'token-a', 's', 'https://r', 9999999999999),
        ('p-gone', 'user-1', NULL, 'token-b', 's', 'https://r', 9999999999999);
    `);

    await revokeRecordedCloneTokens({ DB: db, ARTIFACTS: artifacts }, store);

    // A repository already deleted has no token left to revoke.
    expect(artifacts.revoked).toEqual(['token-a']);
    expect(database.prepare('SELECT repo FROM clone_tokens').all()).toEqual([]);
  });
});
