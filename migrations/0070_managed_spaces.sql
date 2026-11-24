-- A space CloudChef runs is a team of its subscriber's own, in place of a seat in one shared team. Such a team
-- (`managed_host_org_id` set) builds in the Cloudflare account of the host team it names, the operator's, through a
-- connection of its own on that account. Its subscriber runs it (invites, members, projects) and nobody in it has
-- the powers a team's admin has over its Cloudflare account: those stay with the host team's admins.
ALTER TABLE organizations ADD COLUMN managed_host_org_id TEXT REFERENCES organizations(id);

-- The space a subscription gave its person; null before the first one. Not a foreign key: a space that was since
-- deleted is simply not found, and the next subscription in good standing makes another.
ALTER TABLE managed_subscriptions ADD COLUMN space_org_id TEXT;
