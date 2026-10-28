import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import { findReadableApp, listAppsOf, listPublicApps, setAppVisibility, syncApps } from './apps.server';

const GARDEN = '44444444-4444-4444-8444-444444444444';
const RECIPES = '55555555-5555-4555-8555-555555555555';

function setup() {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username) VALUES
      ('ada', 'Ada', 'ada@example.com', 1, 1, 1, 'ada'), ('bo', 'Bo', 'bo@example.com', 1, 1, 1, 'bo');
    INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
      VALUES ('ada-own', 'ada', 'account', 'active', 1, 1);
    INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, created_by, created_at)
      VALUES ('project', 'ada-own', 'Garden', 'garden', 't-project', 'zip', 'ada', 1);
  `);
  return { database, db };
}

describe('apps CloudChef knows', () => {
  it('follows what the owner’s runtime lists: adds, renames, and removes deleted ones', async () => {
    const { db } = setup();
    await syncApps(db, {
      userId: 'ada',
      connectionId: 'ada-own',
      apps: [
        { id: GARDEN, name: 'Garden', siteUrl: 'https://garden.ada.workers.dev' },
        { id: RECIPES, name: 'Recipes', siteUrl: null },
      ],
    });

    // A project of hers is already called garden: the app's address name doesn't take it.
    expect((await listAppsOf(db, 'ada', 'ada-own')).map((app) => [app.name, app.fullName, app.visibility])).toEqual([
      ['Garden', 'ada/garden-2', 'private'],
      ['Recipes', 'ada/recipes', 'private'],
    ]);

    await syncApps(db, {
      userId: 'ada',
      connectionId: 'ada-own',
      apps: [{ id: GARDEN, name: 'Garden club', siteUrl: 'https://garden.ada.workers.dev' }],
    });
    expect((await listAppsOf(db, 'ada', 'ada-own')).map((app) => [app.name, app.fullName, app.repo])).toEqual([
      ['Garden club', 'ada/garden-2', `p-${GARDEN}`],
    ]);
  });

  it('leave out an app a team adopted as one of its projects, which can then be neither public nor copied', async () => {
    const { database, db } = setup();
    await syncApps(db, {
      userId: 'ada',
      connectionId: 'ada-own',
      apps: [
        { id: GARDEN, name: 'Garden', siteUrl: null },
        { id: RECIPES, name: 'Recipes', siteUrl: null },
      ],
    });
    // An admin approved the Recipes draft: its repository is a project's now.
    database.exec(`
      INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, created_by, created_at)
        VALUES ('adopted', 'ada-own', 'Recipes', 'recipes-project', 'p-${RECIPES}', 'draft', 'ada', 2);
    `);

    await syncApps(db, {
      userId: 'ada',
      connectionId: 'ada-own',
      apps: [
        { id: GARDEN, name: 'Garden', siteUrl: null },
        { id: RECIPES, name: 'Recipes', siteUrl: null },
      ],
    });

    expect((await listAppsOf(db, 'ada', 'ada-own')).map((app) => app.id)).toEqual([GARDEN]);
    expect(await findReadableApp(db, { id: RECIPES }, 'ada')).toBeNull();
    expect(await setAppVisibility(db, { userId: 'ada', appId: RECIPES, visibility: 'public' })).toBe(false);
  });

  it('are read by their owner, and by anyone else only once public, which only the owner decides', async () => {
    const { db } = setup();
    await syncApps(db, {
      userId: 'ada',
      connectionId: 'ada-own',
      apps: [{ id: GARDEN, name: 'Garden', siteUrl: null }],
    });

    expect(await findReadableApp(db, { id: GARDEN }, 'ada')).toMatchObject({ role: 'owner' });
    expect(await findReadableApp(db, { owner: 'ada', slug: 'garden-2' }, 'bo')).toBeNull();
    expect(await setAppVisibility(db, { userId: 'bo', appId: GARDEN, visibility: 'public' })).toBe(false);
    expect(await setAppVisibility(db, { userId: 'ada', appId: GARDEN, visibility: 'public' })).toBe(true);
    expect(await findReadableApp(db, { owner: 'ada', slug: 'garden-2' }, 'bo')).toMatchObject({
      id: GARDEN,
      role: 'public',
    });
    expect((await listPublicApps(db)).map((app) => [app.fullName, app.ownerName])).toEqual([['ada/garden-2', 'Ada']]);
  });
});
