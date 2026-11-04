import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import { findReadableProject, renameProject } from './org-projects.server';
import { findPostByAddress } from './posts.server';

function setup() {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username) VALUES
      ('sara', 'Sara', 'sara@example.test', 1, 1, 1, 'sara'),
      ('ben', 'Ben', 'ben@example.test', 1, 1, 1, 'ben');
    INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
      VALUES ('sara-account', 'sara', 'account', 'active', 1, 1);
    INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, visibility, created_by,
      deploy_worker_name, created_at) VALUES
      ('recipes', 'sara-account', 'recipes', 'recipes', 't-recipes', 'zip', 'private', 'sara', 'recipes-worker', 1),
      ('notes', 'sara-account', 'My Own Notes', 'notes', 't-notes', 'zip', 'public', 'sara', NULL, 1);
  `);
  return { database, db };
}

describe('renaming a project', () => {
  it('moves its address, and its name when that was its address name, but not its Worker', async () => {
    const { database, db } = setup();
    expect(await renameProject(db, { userId: 'sara', projectId: 'recipes', slug: 'recipe-box' })).toEqual({
      fullName: 'sara/recipe-box',
    });
    expect(
      database.prepare(`SELECT name, slug, deploy_worker_name FROM org_projects WHERE id = 'recipes'`).get(),
    ).toEqual({
      name: 'recipe-box',
      slug: 'recipe-box',
      deploy_worker_name: 'recipes-worker',
    });
  });

  it('keeps a name people chose', async () => {
    const { database, db } = setup();
    await renameProject(db, { userId: 'sara', projectId: 'notes', slug: 'journal' });
    expect(database.prepare(`SELECT name FROM org_projects WHERE id = 'notes'`).get()).toEqual({
      name: 'My Own Notes',
    });
  });

  it('answers at every address it has had, through as many renames', async () => {
    const { db } = setup();
    await renameProject(db, { userId: 'sara', projectId: 'recipes', slug: 'second' });
    await renameProject(db, { userId: 'sara', projectId: 'recipes', slug: 'third' });
    for (const slug of ['recipes', 'second', 'third']) {
      expect((await findReadableProject(db, { owner: 'sara', slug }, 'sara'))?.fullName).toBe('sara/third');
    }
  });

  it('shows a private project at its old address only to those who may read it', async () => {
    const { db } = setup();
    await renameProject(db, { userId: 'sara', projectId: 'recipes', slug: 'recipe-box' });
    expect(await findReadableProject(db, { owner: 'sara', slug: 'recipes' }, 'ben')).toBeNull();
  });

  it('finds a public project’s post by its old address, saying where it is now', async () => {
    const { db } = setup();
    await renameProject(db, { userId: 'sara', projectId: 'notes', slug: 'journal' });
    expect((await findPostByAddress(db, 'sara', 'notes')).project?.slug).toBe('journal');
    expect((await findPostByAddress(db, 'sara', 'journal')).project?.slug).toBe('journal');
  });

  it('is refused for someone who does not manage it, a name in use, and a name that is no address', async () => {
    const { db } = setup();
    expect(await renameProject(db, { userId: 'ben', projectId: 'recipes', slug: 'mine' })).toBe('forbidden');
    expect(await renameProject(db, { userId: 'sara', projectId: 'recipes', slug: 'notes' })).toBe('taken');
    expect(await renameProject(db, { userId: 'sara', projectId: 'recipes', slug: 'Not An Address' })).toBe('invalid');
    expect((await findReadableProject(db, { owner: 'sara', slug: 'recipes' }, 'sara'))?.fullName).toBe('sara/recipes');
  });

  it('lets a project already there come before an old name, and another take the old name over', async () => {
    const { db } = setup();
    await renameProject(db, { userId: 'sara', projectId: 'recipes', slug: 'recipe-box' });
    await renameProject(db, { userId: 'sara', projectId: 'notes', slug: 'recipes' });
    expect((await findReadableProject(db, { owner: 'sara', slug: 'recipes' }, 'sara'))?.id).toBe('notes');
    expect((await findPostByAddress(db, 'sara', 'recipes')).project?.id).toBe('notes');
  });

  it('can go back to a name it had', async () => {
    const { database, db } = setup();
    await renameProject(db, { userId: 'sara', projectId: 'recipes', slug: 'recipe-box' });
    await renameProject(db, { userId: 'sara', projectId: 'recipes', slug: 'recipes' });
    expect(database.prepare('SELECT slug FROM project_slug_redirects').all()).toEqual([{ slug: 'recipe-box' }]);
  });
});
