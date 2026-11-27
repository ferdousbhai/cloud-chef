import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { retireEmptySpaces } from './retire-spaces';

/**
 * Ada's own space with a project, and two she made beside it in the same Cloudflare account: Old, emptied, where
 * she and Sam each have a workspace, and Kept, which still has a project.
 */
function world() {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
      ('ada', 'Ada', 'ada@example.com', 1, 1, 1), ('sam', 'Sam', 'sam@example.com', 1, 1, 1);
    INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at) VALUES ('grant', 'x', 'y', 1);
    INSERT INTO cloudflare_authorizations (account_id, credential_handle, created_at, updated_at)
      VALUES ('account-ada', 'grant', 1, 1);
    INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
      VALUES ('ada-own', 'ada', 'account-ada', 'active', 1, 1);
    INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES
      ('old', 'Old', 'ada', 2, 2), ('kept', 'Kept', 'ada', 3, 3);
    INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at) VALUES
      ('old-connection', 'old', 'account-ada', 'active', 2, 2),
      ('kept-connection', 'kept', 'account-ada', 'active', 3, 3);
    INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
      ('old', 'ada', 'admin', 2), ('old', 'sam', 'member', 3), ('kept', 'ada', 'admin', 3);
    INSERT INTO org_projects (id, connection_id, org_id, name, slug, artifact_repo, created_from,
      created_by, created_at) VALUES
      ('mine', 'ada-own', 'ada-own', 'Mine', 'mine', 't-mine', 'chat', 'ada', 1),
      ('theirs', 'kept-connection', 'kept', 'Theirs', 'theirs', 't-theirs', 'chat', 'ada', 3);
    INSERT INTO user_computer_runtimes (user_id, connection_id, connection_generation, worker_name, endpoint,
      runtime_version, status, created_at, updated_at) VALUES
      ('ada', 'old-connection', 1, 'ada-old', 'https://ada-old.example', 'sha', 'ready', 1, 1),
      ('sam', 'old-connection', 1, 'sam-old', 'https://sam-old.example', 'sha', 'ready', 1, 1),
      ('ada', 'ada-own', 1, 'ada-own', 'https://ada-own.example', 'sha', 'ready', 1, 1);
  `);
  const spaces = () =>
    database
      .prepare('SELECT id FROM organizations ORDER BY id')
      .all()
      .map((row) => String(row.id));
  return { database, env: envWith({ DB: db }), spaces };
}

describe('a space left over beside a person’s own', () => {
  it('goes once it has no project, with its people’s workspaces, and nothing else does', async () => {
    const { database, env, spaces } = world();
    const deleted: string[] = [];
    const revoked: string[] = [];

    const retired = await retireEmptySpaces(
      env,
      async (_env, orgId, userId) => void deleted.push(`${orgId}:${userId}`),
      async (handle) => {
        revoked.push(handle);
        return true;
      },
    );

    expect(retired).toBe(1);
    expect(deleted.toSorted()).toEqual(['old:ada', 'old:sam']);
    // Her own space, and the one that still has a project, stay; so does the account's authorization they use.
    expect(spaces()).toEqual(['ada-own', 'kept']);
    expect(revoked).toEqual([]);
    expect(database.prepare('SELECT user_id, connection_id FROM user_computer_runtimes').all()).toEqual([
      { user_id: 'ada', connection_id: 'ada-own' },
    ]);
    expect(database.prepare('SELECT COUNT(*) AS kept FROM cloudflare_authorizations').get()).toEqual({ kept: 1 });
  });

  it('stays, whole, while one of its workspaces can’t be deleted, to be tried again', async () => {
    const { database, env, spaces } = world();

    const retired = await retireEmptySpaces(
      env,
      async (_env, _orgId, userId) => {
        if (userId === 'sam') {
          throw new Error('Cloudflare is unavailable');
        }
      },
      async () => true,
    );

    expect(retired).toBe(0);
    expect(spaces()).toEqual(['ada-own', 'kept', 'old']);
    expect(database.prepare(`SELECT status FROM cloudflare_connections WHERE id = 'old-connection'`).get()).toEqual({
      status: 'active',
    });
  });
});
