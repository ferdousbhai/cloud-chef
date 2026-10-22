import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { IdentityConflictError } from './identity-conflict-error';
import { describe, expect, it, vi } from 'vitest';
import { createAuthSession, getAuthSession, setSessionContext, upsertCloudflareUser } from './auth';

describe('Cloudflare auth sessions', () => {
  it('stores only a hash of the opaque cookie and uses secure production cookie attributes', async () => {
    const captured: unknown[] = [];
    const env = {
      DB: {
        prepare: vi.fn(() => ({
          bind: (...values: unknown[]) => ({
            run: async () => {
              captured.push(...values);
              return { success: true };
            },
          }),
        })),
      },
    } as unknown as Env;

    const { cookie } = await createAuthSession(env, 'user-1', new Request('https://cloudchef.build/connect/return'));
    const token = cookie.match(/^cloudchef_session=([^;]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(captured[1]).toBe('user-1');
    expect(captured[2]).toMatch(/^[0-9a-f]{64}$/);
    expect(captured[2]).not.toBe(token);
  });

  it('accepts a session without a Cloudflare connection, and offers each account the person may build in', async () => {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('user-1', 'Person', 'person@example.com', 1, 1, 1);
    `);
    const env = envWith({ DB: db });
    const cookie = (await createAuthSession(env, 'user-1', new Request('https://cloudchef.build/'))).cookie.split(
      ';',
    )[0];
    const request = () => new Request('https://cloudchef.build/', { headers: { cookie } });

    // Signed in by email: a session, but nowhere to build yet.
    await expect(getAuthSession(env, request())).resolves.toMatchObject({ context: null, contexts: [] });

    database.exec(`
      INSERT INTO cloudflare_connections (id, user_id, account_id, account_name, status, created_at, updated_at)
        VALUES ('personal', 'user-1', 'account-1', 'Mine', 'active', 1, 1);
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org-1', 'Acme', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('org-1', 'user-1', 'member', 1);
      INSERT INTO cloudflare_connections (id, org_id, account_id, account_name, status, created_at, updated_at)
        VALUES ('acme', 'org-1', 'account-2', 'Acme', 'active', 1, 1);
    `);
    const both = await getAuthSession(env, request());
    expect(both?.contexts.map((option) => option.connectionId)).toEqual(['personal', 'acme']);
    expect(both?.context?.connectionId).toBe('personal');

    // A chosen organization sticks, until the person is paused there.
    await expect(setSessionContext(env, request(), 'acme')).resolves.toBe(true);
    await expect(getAuthSession(env, request())).resolves.toMatchObject({
      context: { kind: 'organization', orgName: 'Acme', role: 'member' },
    });
    database.exec(`UPDATE organization_members SET paused_at = 2`);
    const paused = await getAuthSession(env, request());
    expect(paused?.context?.connectionId).toBe('personal');
    await expect(setSessionContext(env, request(), 'acme')).resolves.toBe(false);
  });

  it.each([
    ['known only by an email no one proved', null],
    ['whose email CloudChef proved', 5],
  ])('never lets a Cloudflare login take over an account %s', async (_label, provenAt) => {
    const { database, db } = controlPlaneDatabase();
    database
      .prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, email_proven_at)
         VALUES ('existing', 'Old', 'person@example.com', 1, 1, 1, ?)`,
      )
      .run(provenAt);

    await expect(
      upsertCloudflareUser(
        db,
        { subject: 'cf-user-1', email: 'Person@Example.com', name: 'Person', picture: null },
        'Account',
      ),
    ).rejects.toThrow(IdentityConflictError);
    expect(database.prepare('SELECT id, name, cloudflare_subject FROM "user"').all()).toEqual([
      { id: 'existing', name: 'Old', cloudflare_subject: null },
    ]);
  });

  it('never reassigns a verified email already bound to a different Cloudflare subject', async () => {
    const updates: unknown[][] = [];
    const db = subjectAwareEmailDb({ cloudflareSubject: 'cf-user-existing', updates });

    await expect(
      upsertCloudflareUser(
        db,
        { subject: 'cf-user-attacker', email: 'person@example.com', name: 'Other person', picture: null },
        'Account',
      ),
    ).rejects.toThrow('verified email is already linked to a different Cloudflare identity');
    expect(updates).toEqual([]);
  });

  it.each(['subject'] as const)(
    'adopts and exactly updates a concurrently inserted user matched by %s',
    async (match) => {
      const { db, updates } = racedUserDb(match);
      vi.useFakeTimers({ toFake: ['Date'], now: 123 });

      await expect(
        upsertCloudflareUser(
          db,
          { subject: 'cf-user-1', email: 'person@example.com', name: 'Person', picture: null },
          'Account',
        ),
      ).resolves.toMatchObject({ id: 'raced-user', name: 'Person', email: 'person@example.com' });
      expect(updates).toEqual([['cf-user-1', 'Person', 'person@example.com', 1, null, 123, 'raced-user', 'cf-user-1']]);
      vi.useRealTimers();
    },
  );

  it('never adopts a user concurrently created with the same email', async () => {
    const { db, insertError, updates } = racedUserDb('email');

    await expect(
      upsertCloudflareUser(
        db,
        { subject: 'cf-user-1', email: 'person@example.com', name: 'Person', picture: null },
        'Account',
      ),
    ).rejects.toBe(insertError);
    expect(updates).toEqual([]);
  });

  it('preserves the unique insert error when no matching raced identity appears', async () => {
    const { db, insertError, updates } = racedUserDb('none');

    await expect(
      upsertCloudflareUser(
        db,
        { subject: 'cf-user-1', email: 'person@example.com', name: 'Person', picture: null },
        'Account',
      ),
    ).rejects.toBe(insertError);
    expect(updates).toEqual([]);
  });
});

function racedUserDb(match: 'subject' | 'email' | 'none') {
  const insertError = new Error('UNIQUE constraint failed: user.cloudflare_subject');
  const updates: unknown[][] = [];
  let raceVisible = false;
  const racedUser = {
    id: 'raced-user',
    name: 'Winner',
    email: 'person@example.com',
    image: null,
    cloudflare_subject: match === 'subject' ? 'cf-user-1' : null,
    email_proven_at: null,
  };
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (!raceVisible) {
                return null;
              }
              if (sql.includes('WHERE cloudflare_subject = ?')) {
                return match === 'subject' ? racedUser : null;
              }
              if (sql.includes('WHERE email = ?')) {
                return match === 'email' ? racedUser : null;
              }
              return null;
            },
            run: async () => {
              if (sql.includes('INSERT INTO "user"')) {
                raceVisible = true;
                throw insertError;
              }
              if (sql.includes('UPDATE "user"')) {
                updates.push(values);
                return { success: true, meta: { changes: 1 } };
              }
              throw new Error(`Unexpected SQL: ${sql}`);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, insertError, updates };
}

function subjectAwareEmailDb(options: { cloudflareSubject: string | null; updates: unknown[][] }): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (sql.includes('WHERE cloudflare_subject = ?')) {
                return null;
              }
              if (sql.includes('WHERE email = ?')) {
                return {
                  id: 'legacy-user',
                  name: 'Old',
                  email: 'person@example.com',
                  image: null,
                  cloudflare_subject: options.cloudflareSubject,
                  email_proven_at: null,
                };
              }
              return null;
            },
            run: async () => {
              options.updates.push(values);
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}
