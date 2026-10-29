import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase, createProvenEmailUser, inviteToTeam } from '~/test/control-plane-d1';
import { attachCloudflareIdentity, NoAccountError, upsertCloudflareUser, upsertVerifiedEmailUser } from './auth';
import { IdentityConflictError } from './identity-conflict-error';

describe('signing in without Cloudflare, then connecting it', () => {
  it('attaches a Cloudflare login to the user who signed in by email', async () => {
    const { database, db } = controlPlaneDatabase();
    const user = await createProvenEmailUser(db, 'sam@acme.com');
    await expect(attachCloudflareIdentity(db, user.id, 'cf-1')).resolves.toMatchObject({ id: user.id });
    expect(database.prepare('SELECT cloudflare_subject FROM "user" WHERE id = ?').get(user.id)).toEqual({
      cloudflare_subject: 'cf-1',
    });
    // Connecting again with the same login is fine.
    await expect(attachCloudflareIdentity(db, user.id, 'cf-1')).resolves.toMatchObject({ id: user.id });
  });

  it('refuses a Cloudflare login that already belongs to someone else', async () => {
    const { db } = controlPlaneDatabase();
    const ada = await createProvenEmailUser(db, 'ada@acme.com');
    const sam = await createProvenEmailUser(db, 'sam@acme.com');
    await attachCloudflareIdentity(db, ada.id, 'cf-1');
    await expect(attachCloudflareIdentity(db, sam.id, 'cf-1')).rejects.toBeInstanceOf(IdentityConflictError);
  });

  it('refuses a second, different Cloudflare login for the same user', async () => {
    const { db } = controlPlaneDatabase();
    const sam = await createProvenEmailUser(db, 'sam@acme.com');
    await attachCloudflareIdentity(db, sam.id, 'cf-1');
    await expect(attachCloudflareIdentity(db, sam.id, 'cf-2')).rejects.toBeInstanceOf(IdentityConflictError);
  });

  it('treats email addresses case-insensitively', async () => {
    const { db } = controlPlaneDatabase();
    const first = await createProvenEmailUser(db, 'sam@acme.com');
    const second = await upsertVerifiedEmailUser(db, { email: 'Sam@Acme.com' });
    expect(second.id).toBe(first.id);
  });

  it('never lets a Cloudflare sign-in take over someone whose email CloudChef proved', async () => {
    const { db } = controlPlaneDatabase();
    await createProvenEmailUser(db, 'alice@corp.com');
    // Someone sets alice@corp.com as their Cloudflare login email and signs in with Cloudflare.
    await expect(
      upsertCloudflareUser(db, { subject: 'cf-attacker', email: 'Alice@corp.com', name: null, picture: null }, null),
    ).rejects.toBeInstanceOf(IdentityConflictError);
  });

  it('keeps a proven email when the person later signs in with a Cloudflare login that reports another', async () => {
    const { database, db } = controlPlaneDatabase();
    const alice = await createProvenEmailUser(db, 'alice@corp.com');
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
    await inviteToTeam(db, 'victim@corp.com');
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
    const proven = await upsertVerifiedEmailUser(db, { email: 'sam@corp.com' }, owner.id);
    expect(proven.id).toBe(owner.id);
  });

  it('still signs a detached Cloudflare user in with Cloudflare, under their placeholder address', async () => {
    const { db } = controlPlaneDatabase();
    const cloudflareUser = await upsertCloudflareUser(
      db,
      { subject: 'cf-sam', email: 'sam@corp.com', name: 'Sam', picture: null },
      null,
    );
    // Someone (perhaps Sam on another device, not signed in) proves sam@corp.com by link, invited to a team.
    await inviteToTeam(db, 'sam@corp.com');
    await upsertVerifiedEmailUser(db, { email: 'sam@corp.com' });
    await expect(
      upsertCloudflareUser(db, { subject: 'cf-sam', email: 'Sam@corp.com', name: 'Sam', picture: null }, null),
    ).resolves.toMatchObject({ id: cloudflareUser.id, email: 'cf-sam@users.cloudflare.invalid' });
  });
});

describe('signing in with Google or an emailed link', () => {
  it('signs in to the account that has the address', async () => {
    const { db } = controlPlaneDatabase();
    const sam = await createProvenEmailUser(db, 'sam@acme.com');
    await expect(upsertVerifiedEmailUser(db, { email: 'sam@acme.com', googleSubject: 'g-sam' })).resolves.toMatchObject(
      {
        id: sam.id,
      },
    );
  });

  it('makes a new account for an address a team has invited', async () => {
    const { database, db } = controlPlaneDatabase();
    await inviteToTeam(db, 'Kim@Acme.com');
    const kim = await upsertVerifiedEmailUser(db, { email: 'kim@acme.com', name: 'Kim' });
    expect(kim).toMatchObject({ email: 'kim@acme.com', name: 'Kim' });
    expect(
      database.prepare('SELECT email_proven_at IS NOT NULL AS proven FROM "user" WHERE id = ?').get(kim.id),
    ).toEqual({ proven: 1 });
  });

  it('makes no account for an address with neither an account nor a waiting invite, and changes nothing', async () => {
    const { database, db } = controlPlaneDatabase();
    // Someone's Cloudflare login reports the address; CloudChef never checked it.
    const cloudflareUser = await upsertCloudflareUser(
      db,
      { subject: 'cf-1', email: 'lee@acme.com', name: null, picture: null },
      null,
    );
    await expect(upsertVerifiedEmailUser(db, { email: 'lee@acme.com' })).rejects.toBeInstanceOf(NoAccountError);
    await expect(upsertVerifiedEmailUser(db, { email: 'nobody@acme.com' })).rejects.toThrow(
      "There's no CloudChef account for this address.",
    );
    expect(database.prepare('SELECT COUNT(*) AS users FROM "user"').get()).toEqual({ users: 1 });
    expect(database.prepare('SELECT email FROM "user" WHERE id = ?').get(cloudflareUser.id)).toEqual({
      email: 'lee@acme.com',
    });
  });

  it("doesn't count an invite that expired or whose sender is no longer an admin", async () => {
    const { database, db } = controlPlaneDatabase();
    await inviteToTeam(db, 'old@acme.com', -1);
    await expect(upsertVerifiedEmailUser(db, { email: 'old@acme.com' })).rejects.toBeInstanceOf(NoAccountError);
    await inviteToTeam(db, 'lapsed@acme.com');
    database.prepare("UPDATE organization_members SET role = 'member'").run();
    await expect(upsertVerifiedEmailUser(db, { email: 'lapsed@acme.com' })).rejects.toBeInstanceOf(NoAccountError);
  });
});
