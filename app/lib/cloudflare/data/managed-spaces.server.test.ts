import { describe, expect, it } from 'vitest';
import type { BillingConfig } from '~/lib/.server/billing/stripe';
import { runsEveryOtherSpaceInAccount } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { controlPlaneDatabase, createProvenEmailUser } from '~/test/control-plane-d1';
import { canManageModels, readBuilderModelSettings } from './builder-model-settings.server';
import { applySubscription } from './managed-subscriptions.server';
import { findMembership, listWorkspaceContexts } from './organization-access.server';
import {
  createInvite,
  listOrganizations,
  prepareOrganizationDeletion,
  renameOrganization,
  updateMember,
} from './organizations.server';

const HOST = 'host-org';
const config: BillingConfig = {
  secretKey: 'sk_test',
  webhookSecret: 'whsec',
  priceId: 'price_1',
  portalConfigurationId: null,
  creditPriceIds: {},
  domainProductId: null,
  managedOrgId: HOST,
};

/** The operator's host team, connected, and Sam with the space a subscription made them. */
async function setup() {
  const { database, db } = controlPlaneDatabase();
  const operator = await createProvenEmailUser(db, 'operator@cloudchef.example');
  database
    .prepare('INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)')
    .run(HOST, 'Host');
  database
    .prepare("INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', 1)")
    .run(HOST, operator.id);
  database
    .prepare(
      `INSERT INTO cloudflare_connections
         (id, org_id, account_id, status, created_at, updated_at, default_builder_model, allowed_builder_models_json)
       VALUES ('host-connection', ?, 'account-1', 'active', 1, 1, 'model-a', '["model-a"]')`,
    )
    .run(HOST);
  const sam = await createProvenEmailUser(db, 'sam@example.com');
  await applySubscription(db, config, {
    id: 'sub_1',
    customerId: 'cus_1',
    status: 'active',
    trialEndsAt: null,
    currentPeriodEndsAt: 2_000,
    cancelsAtPeriodEnd: false,
    userId: sam.id,
    domainId: null,
  });
  const [context] = await listWorkspaceContexts(db, sam.id);
  if (context?.kind !== 'organization') {
    throw new Error('The subscription made no space.');
  }
  return { database, db, operator, sam, space: context };
}

describe('a space CloudChef runs, for the person who subscribes to it', () => {
  it('is theirs to build in, name and invite people into', async () => {
    const { db, sam, space } = await setup();
    expect(space).toMatchObject({ role: 'admin', managed: true, accountName: 'CloudChef', draftsAllowed: true });
    await renameOrganization(db, { orgId: space.orgId, actorId: sam.id, name: 'Studio' });
    await expect(
      createInvite(db, { orgId: space.orgId, email: 'gia@example.com', role: 'member', invitedBy: sam.id }),
    ).resolves.toMatchObject({ token: expect.any(String) });
    const [listed] = await listOrganizations(db, sam.id);
    expect(listed).toMatchObject({ orgName: 'Studio', managed: true });
    expect(listed?.members).toHaveLength(1);
    expect(listed?.invites).toHaveLength(1);
  });

  it('is theirs alone until someone else joins it: an invitation not yet accepted changes nothing', async () => {
    const { database, db, sam, space } = await setup();
    expect(space.solo).toBe(true);
    await createInvite(db, { orgId: space.orgId, email: 'gia@example.com', role: 'member', invitedBy: sam.id });
    await expect(listWorkspaceContexts(db, sam.id)).resolves.toMatchObject([{ solo: true }]);
    const gia = await createProvenEmailUser(db, 'gia@example.com');
    database
      .prepare("INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'member', 2)")
      .run(space.orgId, gia.id);
    await expect(listWorkspaceContexts(db, sam.id)).resolves.toMatchObject([{ solo: false }]);
    await expect(listWorkspaceContexts(db, gia.id)).resolves.toMatchObject([{ solo: false, role: 'member' }]);
  });

  it('has one person running it for as long as they subscribe: no second admin, no leaving, no deleting', async () => {
    const { database, db, sam, space } = await setup();
    const gia = await createProvenEmailUser(db, 'gia@example.com');
    database
      .prepare("INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'member', 2)")
      .run(space.orgId, gia.id);
    const change = (userId: string, action: Parameters<typeof updateMember>[1]['action']) =>
      updateMember(db, { orgId: space.orgId, actorId: sam.id, userId, action });
    await expect(
      createInvite(db, { orgId: space.orgId, email: 'ada@example.com', role: 'admin', invitedBy: sam.id }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(change(gia.id, 'make_admin')).rejects.toMatchObject({ status: 409 });
    await expect(change(sam.id, 'make_member')).rejects.toMatchObject({ status: 409 });
    await expect(change(sam.id, 'remove')).rejects.toMatchObject({ status: 409 });
    await expect(prepareOrganizationDeletion(db, { orgId: space.orgId, actorId: sam.id })).rejects.toMatchObject({
      status: 409,
    });
    // The people they invited are theirs to pause and remove, and may leave.
    await change(gia.id, 'pause');
    await change(gia.id, 'resume');
    await updateMember(db, { orgId: space.orgId, actorId: gia.id, userId: gia.id, action: 'remove' });
    await expect(findMembership(db, space.orgId, gia.id)).resolves.toBeNull();
  });

  it("follows the host team's models and leaves the Cloudflare account to the host team's admins", async () => {
    const { db, operator, sam, space } = await setup();
    await expect(readBuilderModelSettings(db, space.connectionId)).resolves.toEqual({
      defaultModelId: 'model-a',
      allowedModelIds: ['model-a'],
    });
    await expect(canManageModels(db, sam.id, { userId: null, orgId: space.orgId })).resolves.toBe(false);
    // The operator still runs every space in their account, so they can reconnect it; the subscriber does not.
    const others = (userId: string) =>
      runsEveryOtherSpaceInAccount(db, { userId, owner: null, accountId: 'account-1' });
    await expect(others(operator.id)).resolves.toBe(true);
    await expect(others(sam.id)).resolves.toBe(false);
  });
});
