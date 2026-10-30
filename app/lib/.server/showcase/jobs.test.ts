import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import { projectPublished, type ShowcaseJob } from './jobs';

const COMMIT = 'a'.repeat(40);

function seeded(visibility: 'public' | 'private') {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username)
      VALUES ('sara', 'Sara', 'sara@example.test', 1, 1, 1, 'sara');
    INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
      VALUES ('own', 'sara', 'account', 'active', 1, 1);
    INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, visibility, created_by,
      created_at) VALUES ('recipes', 'own', 'Recipe Box', 'recipe-box', 't-recipes', 'zip', '${visibility}', 'sara', 1);
  `);
  const sent: ShowcaseJob[] = [];
  const env = {
    DB: db,
    SHOWCASE_JOBS: {
      send: async (job: ShowcaseJob) => {
        sent.push(job);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
  };
  return { database, env, sent };
}

const publish = {
  projectId: 'recipes',
  commit: COMMIT,
  pushedBy: 'sara',
  siteUrl: 'https://recipes.example.workers.dev',
  siteFrameable: true,
  publishedAt: 1,
  deployedBy: 'cloudchef' as const,
};

describe('projectPublished', () => {
  it('posts a public project and asks for its screenshot', async () => {
    const { database, env, sent } = seeded('public');
    await projectPublished(env, publish);
    expect(database.prepare('SELECT author_id FROM posts').get()).toEqual({ author_id: 'sara' });
    expect(sent).toMatchObject([{ kind: 'screenshot', commit: COMMIT, siteUrl: publish.siteUrl }]);
  });

  it('never posts a private project', async () => {
    const { database, env, sent } = seeded('private');
    await projectPublished(env, publish);
    expect(database.prepare('SELECT COUNT(*) AS count FROM posts').get()).toEqual({ count: 0 });
    expect(sent).toEqual([]);
  });
});
