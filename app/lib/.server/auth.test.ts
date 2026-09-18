import { describe, expect, it, vi } from 'vitest';
import { createAuthSession, getAuthSession, prepareAuthSession, upsertCloudflareUser } from './auth';

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

    const prepared = await prepareAuthSession('user-1', new Request('https://cloudchef.build/connect/return'), 1_000);
    const cookie = await createAuthSession(env, prepared);
    const token = cookie.match(/^cloudchef_session=([^;]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(captured[1]).toBe('user-1');
    expect(captured[2]).toMatch(/^[0-9a-f]{64}$/);
    expect(captured[2]).not.toBe(token);
  });

  it('adopts a session insert whose exact caller-known identity committed before acknowledgement failed', async () => {
    const acknowledgementError = new Error('session insert acknowledgement failed');
    let committedValues: unknown[] | null = null;
    const db = {
      prepare(_sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              run: async () => {
                committedValues = values;
                throw acknowledgementError;
              },
              first: async () =>
                committedValues && JSON.stringify(values) === JSON.stringify(committedValues) ? { found: 1 } : null,
            };
          },
        };
      },
    } as unknown as D1Database;
    const prepared = await prepareAuthSession('user-1', new Request('https://cloudchef.build/connect/return'), 1_000);

    await expect(createAuthSession({ DB: db } as Env, prepared)).resolves.toBe(prepared.cookie);
    expect(committedValues).toEqual([
      prepared.id,
      prepared.userId,
      prepared.tokenHash,
      prepared.expiresAt,
      prepared.createdAt,
      prepared.createdAt,
    ]);
  });

  it('does not adopt a session insert failure when the committed row differs from the prepared session', async () => {
    const acknowledgementError = new Error('session insert acknowledgement failed');
    let committedValues: unknown[] | null = null;
    const db = {
      prepare(_sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              run: async () => {
                committedValues = [...values];
                committedValues[2] = 'different-token-hash';
                throw acknowledgementError;
              },
              first: async () =>
                committedValues && JSON.stringify(values) === JSON.stringify(committedValues) ? { found: 1 } : null,
            };
          },
        };
      },
    } as unknown as D1Database;
    const prepared = await prepareAuthSession('user-1', undefined, 1_000);

    await expect(createAuthSession({ DB: db } as Env, prepared)).rejects.toBe(acknowledgementError);
  });

  it('accepts a valid session only through an active Cloudflare connection', async () => {
    let query = '';
    let values: unknown[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => {
          query = sql;
          return {
            bind: (...bound: unknown[]) => {
              values = bound;
              return {
                first: async () => ({
                  session_id: 'session-1',
                  user_id: 'user-1',
                  expires_at: Date.now() + 60_000,
                  name: 'Person',
                  email: 'person@example.com',
                  image: null,
                }),
              };
            },
          };
        },
      },
    } as unknown as Env;
    const session = await getAuthSession(
      env,
      new Request('https://cloudchef.build/', { headers: { cookie: 'cloudchef_session=opaque-token' } }),
    );

    expect(query).toContain("connections.status = 'active'");
    expect(values[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(session?.user.id).toBe('user-1');
  });

  it('adopts a matching legacy email so existing projects remain owned by the same user', async () => {
    const updates: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              first: async () => {
                if (sql.includes('cloudflare_subject =')) {
                  return null;
                }
                if (sql.includes('WHERE email =')) {
                  return {
                    id: 'legacy-user',
                    name: 'Old',
                    email: 'person@example.com',
                    image: null,
                    cloudflare_subject: null,
                  };
                }
                return null;
              },
              run: async () => {
                updates.push(values);
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(
      upsertCloudflareUser(
        db,
        { subject: 'cf-user-1', email: 'person@example.com', name: 'Person', picture: null },
        'Account',
        123,
      ),
    ).resolves.toMatchObject({ id: 'legacy-user', name: 'Person' });
    expect(updates[0]).toEqual(['cf-user-1', 'Person', 'person@example.com', 1, null, 123, 'legacy-user', 'cf-user-1']);
  });

  it('never reassigns a verified email already bound to a different Cloudflare subject', async () => {
    const updates: unknown[][] = [];
    const db = subjectAwareEmailDb({ cloudflareSubject: 'cf-user-existing', updates });

    await expect(
      upsertCloudflareUser(
        db,
        { subject: 'cf-user-attacker', email: 'person@example.com', name: 'Other person', picture: null },
        'Account',
        123,
      ),
    ).rejects.toThrow('verified email is already linked to a different Cloudflare identity');
    expect(updates).toEqual([]);
  });

  it('preserves idempotent same-subject adoption by verified email', async () => {
    const updates: unknown[][] = [];
    const db = subjectAwareEmailDb({ cloudflareSubject: 'cf-user-1', updates });

    await expect(
      upsertCloudflareUser(
        db,
        { subject: 'cf-user-1', email: 'person@example.com', name: 'Person', picture: null },
        'Account',
        123,
      ),
    ).resolves.toMatchObject({ id: 'legacy-user', name: 'Person' });
    expect(updates).toEqual([['cf-user-1', 'Person', 'person@example.com', 1, null, 123, 'legacy-user', 'cf-user-1']]);
  });

  it('fails closed if an unbound legacy row is concurrently linked before adoption updates it', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => {
                if (sql.includes('SELECT 1 AS found')) {
                  return null;
                }
                if (sql.includes('WHERE cloudflare_subject = ?')) {
                  return null;
                }
                if (sql.includes('WHERE email = ?')) {
                  return {
                    id: 'legacy-user',
                    name: 'Old',
                    email: 'person@example.com',
                    image: null,
                    cloudflare_subject: null,
                  };
                }
                return null;
              },
              run: async () => ({ success: true, meta: { changes: 0 } }),
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(
      upsertCloudflareUser(
        db,
        { subject: 'cf-user-1', email: 'person@example.com', name: 'Person', picture: null },
        'Account',
        123,
      ),
    ).rejects.toThrow('Cloudflare user changed while authentication was being persisted');
  });

  it('adopts only an exact new user insert whose acknowledgement failed after commit', async () => {
    const acknowledgementError = new Error('user insert acknowledgement failed');
    const exact = userMutationDb({ mutation: 'insert', acknowledgementError });
    const mismatched = userMutationDb({
      mutation: 'insert',
      acknowledgementError,
      mismatchAfterCommit: true,
    });
    const identity = { subject: 'cf-user-1', email: 'person@example.com', name: 'Person', picture: null };

    await expect(upsertCloudflareUser(exact, identity, 'Account', 123)).resolves.toMatchObject({
      name: 'Person',
      email: 'person@example.com',
    });
    await expect(upsertCloudflareUser(mismatched, identity, 'Account', 123)).rejects.toBe(acknowledgementError);
  });

  it('adopts only an exact existing-user update whose acknowledgement failed after commit', async () => {
    const acknowledgementError = new Error('user update acknowledgement failed');
    const exact = userMutationDb({ mutation: 'update', acknowledgementError });
    const mismatched = userMutationDb({
      mutation: 'update',
      acknowledgementError,
      mismatchAfterCommit: true,
    });
    const identity = { subject: 'cf-user-1', email: 'person@example.com', name: 'Person', picture: null };

    await expect(upsertCloudflareUser(exact, identity, 'Account', 123)).resolves.toMatchObject({
      id: 'existing-user',
      name: 'Person',
    });
    await expect(upsertCloudflareUser(mismatched, identity, 'Account', 123)).rejects.toBe(acknowledgementError);
  });

  it.each(['subject', 'email'] as const)(
    'adopts and exactly updates a concurrently inserted user matched by %s',
    async (match) => {
      const { db, updates } = racedUserDb(match);

      await expect(
        upsertCloudflareUser(
          db,
          { subject: 'cf-user-1', email: 'person@example.com', name: 'Person', picture: null },
          'Account',
          123,
        ),
      ).resolves.toMatchObject({ id: 'raced-user', name: 'Person', email: 'person@example.com' });
      expect(updates).toEqual([['cf-user-1', 'Person', 'person@example.com', 1, null, 123, 'raced-user', 'cf-user-1']]);
    },
  );

  it('preserves the unique insert error when no matching raced identity appears', async () => {
    const { db, insertError, updates } = racedUserDb('none');

    await expect(
      upsertCloudflareUser(
        db,
        { subject: 'cf-user-1', email: 'person@example.com', name: 'Person', picture: null },
        'Account',
        123,
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
  };
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (sql.includes('SELECT 1 AS found')) {
                return null;
              }
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

function userMutationDb(options: {
  mutation: 'insert' | 'update';
  acknowledgementError: Error;
  mismatchAfterCommit?: boolean;
}): D1Database {
  type StoredUser = {
    id: string;
    subject: string;
    name: string;
    email: string;
    emailVerified: number;
    image: string | null;
    createdAt: number;
    updatedAt: number;
  };
  let user: StoredUser | null =
    options.mutation === 'update'
      ? {
          id: 'existing-user',
          subject: 'cf-user-1',
          name: 'Old name',
          email: 'old@example.com',
          emailVerified: 1,
          image: null,
          createdAt: 1,
          updatedAt: 1,
        }
      : null;
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              const current = user;
              if (sql.includes('SELECT 1 AS found')) {
                if (!current) {
                  return null;
                }
                const expectedCreatedAt = values.length === 8 ? values[7] : undefined;
                const matches =
                  current.id === values[0] &&
                  current.subject === values[1] &&
                  current.name === values[2] &&
                  current.email === values[3] &&
                  current.emailVerified === values[4] &&
                  current.image === values[5] &&
                  current.updatedAt === values[6] &&
                  (expectedCreatedAt === undefined || current.createdAt === expectedCreatedAt);
                return matches ? { found: 1 } : null;
              }
              if (sql.includes('WHERE cloudflare_subject = ?')) {
                if (current && current.subject === values[0]) {
                  return { id: current.id, name: current.name, email: current.email, image: current.image };
                }
                return null;
              }
              if (sql.includes('WHERE email = ?')) {
                if (current && current.email === values[0]) {
                  return {
                    id: current.id,
                    name: current.name,
                    email: current.email,
                    image: current.image,
                    cloudflare_subject: current.subject,
                  };
                }
                return null;
              }
              return null;
            },
            run: async () => {
              if (sql.includes('INSERT INTO "user"')) {
                user = {
                  id: values[0] as string,
                  name: values[1] as string,
                  email: values[2] as string,
                  emailVerified: values[3] as number,
                  image: values[4] as string | null,
                  createdAt: values[5] as number,
                  updatedAt: (values[6] as number) + (options.mismatchAfterCommit ? 1 : 0),
                  subject: values[7] as string,
                };
              } else if (sql.includes('UPDATE "user"') && user) {
                user = {
                  ...user,
                  subject: values[0] as string,
                  name: values[1] as string,
                  email: values[2] as string,
                  emailVerified: values[3] as number,
                  image: values[4] as string | null,
                  updatedAt: (values[5] as number) + (options.mismatchAfterCommit ? 1 : 0),
                };
              }
              throw options.acknowledgementError;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}
