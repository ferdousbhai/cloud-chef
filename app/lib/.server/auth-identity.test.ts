import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import { attachCloudflareIdentity, upsertCloudflareUser, upsertVerifiedEmailUser } from './auth';
import { IdentityConflictError } from './identity-conflict-error';

describe('signing in without Cloudflare, then connecting it', () => {
  it('attaches a Cloudflare login to the user who signed in by email', async () => {
    const { database, db } = controlPlaneDatabase();
    const user = await upsertVerifiedEmailUser(db, { email: 'sam@acme.com' });
    await expect(attachCloudflareIdentity(db, user.id, 'cf-1')).resolves.toMatchObject({ id: user.id });
    expect(database.prepare('SELECT cloudflare_subject FROM "user" WHERE id = ?').get(user.id)).toEqual({
      cloudflare_subject: 'cf-1',
    });
    // Connecting again with the same login is fine.
    await expect(attachCloudflareIdentity(db, user.id, 'cf-1')).resolves.toMatchObject({ id: user.id });
  });

  it('refuses a Cloudflare login that already belongs to someone else', async () => {
    const { db } = controlPlaneDatabase();
    const ada = await upsertVerifiedEmailUser(db, { email: 'ada@acme.com' });
    const sam = await upsertVerifiedEmailUser(db, { email: 'sam@acme.com' });
    await attachCloudflareIdentity(db, ada.id, 'cf-1');
    await expect(attachCloudflareIdentity(db, sam.id, 'cf-1')).rejects.toBeInstanceOf(IdentityConflictError);
  });

  it('refuses a second, different Cloudflare login for the same user', async () => {
    const { db } = controlPlaneDatabase();
    const sam = await upsertVerifiedEmailUser(db, { email: 'sam@acme.com' });
    await attachCloudflareIdentity(db, sam.id, 'cf-1');
    await expect(attachCloudflareIdentity(db, sam.id, 'cf-2')).rejects.toBeInstanceOf(IdentityConflictError);
  });

  it('treats email addresses case-insensitively', async () => {
    const { db } = controlPlaneDatabase();
    const first = await upsertVerifiedEmailUser(db, { email: 'Sam@Acme.com' });
    const second = await upsertVerifiedEmailUser(db, { email: 'sam@acme.com' });
    expect(second.id).toBe(first.id);
  });

  it('never lets a Cloudflare sign-in take over someone whose email CloudChef proved', async () => {
    const { db } = controlPlaneDatabase();
    await upsertVerifiedEmailUser(db, { email: 'alice@corp.com' });
    // Someone sets alice@corp.com as their Cloudflare login email and signs in with Cloudflare.
    await expect(
      upsertCloudflareUser(db, { subject: 'cf-attacker', email: 'Alice@corp.com', name: null, picture: null }, null),
    ).rejects.toBeInstanceOf(IdentityConflictError);
  });

  it('keeps a proven email when the person later signs in with a Cloudflare login that reports another', async () => {
    const { database, db } = controlPlaneDatabase();
    const alice = await upsertVerifiedEmailUser(db, { email: 'alice@corp.com' });
    await attachCloudflareIdentity(db, alice.id, 'cf-alice');
    const signedIn = await upsertCloudflareUser(
      db,
      { subject: 'cf-alice', email: 'alice@gmail.com', name: 'Alice', picture: null },
      null,
    );
    expect(signedIn).toMatchObject({ id: alice.id, email: 'alice@corp.com' });
    expect(database.prepare('SELECT email FROM "user" WHERE id = ?').get(alice.id)).toEqual({
      email: 'alice@corp.com',
    });
  });

  it("doesn't let an email someone's Cloudflare login merely reports capture the person who proves it", async () => {
    const { database, db } = controlPlaneDatabase();
    // An attacker's Cloudflare login reports the victim's address: a user CloudChef never checked.
    const attacker = await upsertCloudflareUser(
      db,
      { subject: 'cf-attacker', email: 'victim@corp.com', name: null, picture: null },
      null,
    );
    const victim = await upsertVerifiedEmailUser(db, { email: 'victim@corp.com' });
    expect(victim.id).not.toBe(attacker.id);
    expect(database.prepare('SELECT email FROM "user" WHERE id = ?').get(attacker.id)).toEqual({
      email: 'cf-attacker@users.cloudflare.invalid',
    });
  });

  it('records the proof on a Cloudflare user who proves their own email while signed in', async () => {
    const { db } = controlPlaneDatabase();
    const owner = await upsertCloudflareUser(
      db,
      { subject: 'cf-sam', email: 'sam@corp.com', name: 'Sam', picture: null },
      null,
    );
    const proven = await upsertVerifiedEmailUser(db, { email: 'sam@corp.com' }, Date.now(), owner.id);
    expect(proven.id).toBe(owner.id);
  });

  it('still signs a detached Cloudflare user in with Cloudflare, under their placeholder address', async () => {
    const { db } = controlPlaneDatabase();
    const cloudflareUser = await upsertCloudflareUser(
      db,
      { subject: 'cf-sam', email: 'sam@corp.com', name: 'Sam', picture: null },
      null,
    );
    // Someone (perhaps Sam on another device, not signed in) proves sam@corp.com by link.
    await upsertVerifiedEmailUser(db, { email: 'sam@corp.com' });
    await expect(
      upsertCloudflareUser(db, { subject: 'cf-sam', email: 'Sam@corp.com', name: 'Sam', picture: null }, null),
    ).resolves.toMatchObject({ id: cloudflareUser.id, email: 'cf-sam@users.cloudflare.invalid' });
  });
});
