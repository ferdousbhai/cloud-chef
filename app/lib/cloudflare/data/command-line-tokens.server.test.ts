import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import {
  approveCommandLineLogin,
  commandLineTokenUser,
  pendingCommandLineLogin,
  pollCommandLineLogin,
  startCommandLineLogin,
  createCommandLineToken,
  listCommandLineTokens,
  revokeCommandLineToken,
  TooManyCommandLineTokensError,
} from './command-line-tokens.server';

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('user-1', 'Person', 'person@example.com', 1, 1, 1), ('user-2', 'Other', 'other@example.com', 1, 1, 1);
  `);
  return { database, db };
}

describe('command-line tokens', () => {
  it('gives the token once and keeps only its hash, then knows whose it is', async () => {
    const { database, db } = setup();
    const { token, record } = await createCommandLineToken(db, 'user-1', 'Work laptop');

    expect(token).toMatch(/^cct_[A-Za-z0-9_-]{40,}$/);
    const stored = database.prepare('SELECT * FROM command_line_tokens').all();
    expect(JSON.stringify(stored)).not.toContain(token.slice(4));
    expect(await listCommandLineTokens(db, 'user-1')).toEqual([record]);
    expect(await listCommandLineTokens(db, 'user-2')).toEqual([]);
    expect(await commandLineTokenUser(db, token)).toBe('user-1');
  });

  it('notes when a token was last used', async () => {
    const { db } = setup();
    const { token } = await createCommandLineToken(db, 'user-1', 'Work laptop');

    await commandLineTokenUser(db, token);

    expect((await listCommandLineTokens(db, 'user-1'))[0]?.lastUsedAt).toEqual(expect.any(Number));
  });

  it('stops a revoked token at once, and lets only its owner revoke it', async () => {
    const { db } = setup();
    const { token, record } = await createCommandLineToken(db, 'user-1', 'Work laptop');

    expect(await revokeCommandLineToken(db, 'user-2', record.id)).toBe(false);
    expect(await commandLineTokenUser(db, token)).toBe('user-1');
    expect(await revokeCommandLineToken(db, 'user-1', record.id)).toBe(true);
    expect(await commandLineTokenUser(db, token)).toBeNull();
  });

  it('stops a token once it expires', async () => {
    const { db } = setup();
    const { token } = await createCommandLineToken(db, 'user-1', 'Work laptop');

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 91 * 24 * 60 * 60 * 1_000 });

    expect(await commandLineTokenUser(db, token)).toBeNull();
    expect(await listCommandLineTokens(db, 'user-1')).toEqual([]);
  });

  it('knows nothing of strings that are not its tokens', async () => {
    const { db } = setup();
    await createCommandLineToken(db, 'user-1', 'Work laptop');

    expect(await commandLineTokenUser(db, '')).toBeNull();
    expect(await commandLineTokenUser(db, 'cct_not-a-real-token')).toBeNull();
    expect(await commandLineTokenUser(db, 'session-cookie-value')).toBeNull();
  });

  it('keeps a person to ten live tokens', async () => {
    const { db } = setup();
    for (let index = 0; index < 10; index += 1) {
      await createCommandLineToken(db, 'user-1', `Token ${index}`);
    }

    await expect(createCommandLineToken(db, 'user-1', 'One more')).rejects.toBeInstanceOf(
      TooManyCommandLineTokensError,
    );
    await expect(createCommandLineToken(db, 'user-2', 'Theirs')).resolves.toBeTruthy();
  });
});

describe('signing in the command line from a browser', () => {
  it('waits for approval, then hands over a token of the approver once', async () => {
    const { db } = setup();
    const { deviceCode, userCode } = await startCommandLineLogin(db, 'laptop (cloudchef CLI)');

    expect(userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(await pollCommandLineLogin(db, deviceCode)).toBe('pending');
    expect(await pendingCommandLineLogin(db, userCode)).toEqual({ label: 'laptop (cloudchef CLI)' });

    expect(await approveCommandLineLogin(db, userCode.toLowerCase().replace('-', ' '), 'user-1')).toBe(true);
    const taken = await pollCommandLineLogin(db, deviceCode);
    expect(taken).toEqual({ token: expect.stringMatching(/^cct_/), userId: 'user-1' });
    if (taken === 'pending' || taken === 'expired') {
      throw new Error(`The approved sign-in was ${taken}.`);
    }
    expect(await commandLineTokenUser(db, taken.token)).toBe('user-1');
    expect((await listCommandLineTokens(db, 'user-1')).map((token) => token.label)).toEqual(['laptop (cloudchef CLI)']);

    expect(await pollCommandLineLogin(db, deviceCode)).toBe('expired');
    expect(await approveCommandLineLogin(db, userCode, 'user-2')).toBe(false);
  });

  it('lets no one approve or take a sign-in after ten minutes', async () => {
    const { db } = setup();
    const { deviceCode, userCode } = await startCommandLineLogin(db, 'laptop');

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11 * 60 * 1_000 });

    expect(await approveCommandLineLogin(db, userCode, 'user-1')).toBe(false);
    expect(await pollCommandLineLogin(db, deviceCode)).toBe('expired');
    expect(await pendingCommandLineLogin(db, userCode)).toBeNull();
  });

  it('knows nothing of a device code it never gave', async () => {
    const { db } = setup();
    await startCommandLineLogin(db, 'laptop');

    expect(await pollCommandLineLogin(db, 'made-up-device-code-of-some-length')).toBe('expired');
  });
});
