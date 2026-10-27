import { describe, expect, it } from 'vitest';
import { createCommandLineToken } from '~/lib/cloudflare/data/command-line-tokens.server';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { createAuthSession } from '~/lib/.server/auth';
import {
  commandLineGitAction,
  commandLineProjectsAction,
  isCommandLineGitPath,
  setUsernameAction,
} from './command-line';

const PROJECT = '11111111-1111-4111-8111-111111111111';

async function setup() {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('user-1', 'Person', 'person@example.com', 1, 1, 1);
  `);
  const { token } = await createCommandLineToken(db, 'user-1', 'Laptop');
  return { env: envWith({ DB: db }), token };
}

function git(path: string, authorization?: string) {
  return new Request(`https://cloudchef.build${path}`, authorization ? { headers: { authorization } } : undefined);
}

describe('git from the command line', () => {
  it('answers only a project repository’s git paths', () => {
    expect(isCommandLineGitPath(`/git/${PROJECT}.git/info/refs`)).toBe(true);
    expect(isCommandLineGitPath(`/git/${PROJECT}.git/git-receive-pack`)).toBe(true);
    expect(isCommandLineGitPath(`/git/${PROJECT}.git/HEAD`)).toBe(false);
    expect(isCommandLineGitPath('/git/../api/settings.git/info/refs')).toBe(false);
  });

  it('asks git for a token, in a way git prompts for and its credential helpers store', async () => {
    const { env } = await setup();

    const answer = await commandLineGitAction({ request: git(`/git/${PROJECT}.git/info/refs`), env });

    expect(answer.status).toBe(401);
    expect(answer.headers.get('WWW-Authenticate')).toContain('Basic');
    expect(await answer.text()).toContain('command-line token');
  });

  it('refuses a password that is not a live token', async () => {
    const { env } = await setup();

    const answer = await commandLineGitAction({
      request: git(`/git/${PROJECT}.git/info/refs`, `Basic ${btoa('me:not-a-token')}`),
      env,
    });

    expect(answer.status).toBe(401);
  });

  it('says a project the person may not see is not there, with a token as git sends it', async () => {
    const { env, token } = await setup();

    const answer = await commandLineGitAction({
      request: git(`/git/${PROJECT}.git/info/refs?service=git-upload-pack`, `Basic ${btoa(`anyone:${token}`)}`),
      env,
    });

    expect(answer.status).toBe(404);
  });

  it('lists projects only for a token, as a Bearer token', async () => {
    const { env, token } = await setup();

    const refused = await commandLineProjectsAction({
      request: new Request('https://cloudchef.build/api/command-line/projects'),
      env,
    });
    expect(refused.status).toBe(401);

    const listed = await commandLineProjectsAction({
      request: new Request('https://cloudchef.build/api/command-line/projects', {
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ projects: [] });
  });
});

describe('choosing a username', () => {
  async function signedInAs(userId: string) {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username)
        VALUES ('user-1', 'Person', 'person@example.com', 1, 1, 1, NULL),
               ('user-2', 'Other', 'other@example.com', 1, 1, 1, 'taken');
    `);
    const env = envWith({ DB: db });
    const cookie = (await createAuthSession(env, userId, new Request('https://cloudchef.build/'))).cookie.split(
      ';',
    )[0]!;
    const save = (username: string) =>
      setUsernameAction({
        request: new Request('https://cloudchef.build/api/profile/username', {
          method: 'POST',
          headers: { cookie, origin: 'https://cloudchef.build', 'content-type': 'application/json' },
          body: JSON.stringify({ username }),
        }),
        env,
      });
    return { database, save };
  }

  it('saves a free one, in lowercase', async () => {
    const { database, save } = await signedInAs('user-1');

    const answer = await save('Ferdous');

    expect(answer.status).toBe(200);
    expect(database.prepare(`SELECT username FROM "user" WHERE id = 'user-1'`).get()).toEqual({ username: 'ferdous' });
  });

  it('refuses one that is taken, kept back, or not an address', async () => {
    const { save } = await signedInAs('user-1');

    expect((await save('taken')).status).toBe(409);
    expect((await save('settings')).status).toBe(400);
    expect((await save('two words')).status).toBe(400);
  });
});
