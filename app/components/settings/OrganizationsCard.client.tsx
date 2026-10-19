import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import {
  authClient,
  createCloudflareReturnURL,
  ReauthenticationRequiredError,
  signInWithCloudflare,
  switchWorkspace,
} from '~/lib/auth-client';
import { ReauthenticateButtons } from './ReauthenticateButtons.client';
import {
  MyOrgProjects,
  OrgProjectsSection,
  orgGitHubSchema,
  orgProjectSchema,
  ownRequestSchema,
  productionRequestSchema,
} from './OrgProjectsSection.client';
import { messageOf, noContentSchema, postJson, run } from './organization-requests.client';

const roleSchema = z.enum(['admin', 'member']);
const organizationsSchema = z.object({
  organizations: z.array(
    z.object({
      orgId: z.string(),
      orgName: z.string(),
      role: roleSchema,
      pausedAt: z.number().nullable(),
      connection: z.object({ accountName: z.string().nullable(), active: z.boolean() }).nullable(),
      members: z
        .array(
          z.object({
            userId: z.string(),
            name: z.string(),
            email: z.string(),
            role: roleSchema,
            pausedAt: z.number().nullable(),
            draftsAllowed: z.boolean(),
            usage: z.object({ turns: z.number(), inputTokens: z.number(), outputTokens: z.number() }),
          }),
        )
        .nullable(),
      invites: z.array(z.object({ id: z.string(), email: z.string(), role: roleSchema })).nullable(),
      github: orgGitHubSchema,
      projects: z.array(orgProjectSchema),
      productionRequests: z.array(productionRequestSchema).nullable(),
      ownRequests: z.array(ownRequestSchema),
    }),
  ),
});
const createdSchema = z.object({ orgId: z.string() });
const invitedSchema = z.object({ inviteUrl: z.string(), emailed: z.boolean() });
const memberUpdatedSchema = z.object({ ok: z.literal(true), workspaceDeleted: z.boolean().optional() });

type MemberAction = 'pause' | 'resume' | 'remove' | 'make_admin' | 'make_member' | 'allow_drafts' | 'disallow_drafts';

type Organization = z.infer<typeof organizationsSchema>['organizations'][number];

/**
 * Organizations: people sharing one Cloudflare account to build in. An admin connects the account and
 * invites people by email; they sign in with Google or an emailed link, without Cloudflare logins.
 */
export function OrganizationsCard() {
  const { data: session } = authClient.useSession();
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // Why a fresh sign-in is needed first (creating or connecting an organization asks for a recent one).
  const [signInReason, setSignInReason] = useState<string | null>(null);
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/organizations', { credentials: 'same-origin' });
    const parsed = organizationsSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) {
      throw new Error('Unable to load your organizations.');
    }
    setOrganizations(parsed.data.organizations);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (loadError) {
        setError(messageOf(loadError instanceof Error ? loadError : null, 'Unable to load your organizations.'));
      }
    })();
  }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { orgId } = await postJson('/api/organizations/create', { name: name.trim() }, createdSchema);
      // Straight on to connecting its Cloudflare account, which only its admin can do.
      await signInWithCloudflare(createCloudflareReturnURL(window.location.href), { organizationId: orgId });
    } catch (createError) {
      if (createError instanceof ReauthenticationRequiredError) {
        setSignInReason(createError.message);
      } else {
        setError(messageOf(createError instanceof Error ? createError : null, 'Unable to create the organization.'));
      }
      setBusy(false);
      // It may exist by now, waiting for its Cloudflare account.
      void load().catch(() => undefined);
    }
  };

  return (
    <section id="organizations" className="app-card w-full p-4" aria-labelledby="organizations-heading">
      <h2 id="organizations-heading" className="app-card-title">
        Organizations
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        Share one Cloudflare account with the people you work with. They sign in with Google or an emailed link, without
        Cloudflare logins of their own, and each builds in their own workspace there.
      </p>
      {error ? (
        <p className="mt-3 text-sm text-bolt-elements-icon-error" role="alert">
          {error}
        </p>
      ) : null}
      {signInReason ? (
        <div role="status" className="mt-3 text-sm text-content-secondary">
          <p>{linkSentTo ? `Open the link sent to ${linkSentTo}, then come back here and try again.` : signInReason}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <ReauthenticateButtons onError={setError} onLinkSent={setLinkSentTo} />
          </div>
        </div>
      ) : null}
      {organizations === null && !error ? (
        <p className="mt-3 text-sm text-content-secondary" role="status">
          Loading…
        </p>
      ) : null}
      <div className="mt-3 grid gap-3">
        {organizations?.map((organization) => (
          <OrganizationRow
            key={organization.orgId}
            organization={organization}
            // The account to open: the session lists the organizations this person may build in now.
            connectionId={
              session?.contexts.find((option) => option.kind === 'organization' && option.orgId === organization.orgId)
                ?.connectionId ?? null
            }
            current={session?.context?.kind === 'organization' && session.context.orgId === organization.orgId}
            myUserId={session?.user.id ?? null}
            onChanged={() => void load()}
            onSignInRequired={setSignInReason}
          />
        ))}
      </div>
      <form className="mt-4 flex flex-wrap gap-2" onSubmit={(event) => void create(event)}>
        <TextInput
          required
          maxLength={80}
          placeholder="Organization name"
          aria-label="Organization name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="sm" variant="neutral" loading={busy}>
          Create and connect Cloudflare
        </Button>
      </form>
    </section>
  );
}

function OrganizationRow({
  organization,
  connectionId,
  current,
  myUserId,
  onChanged,
  onSignInRequired,
}: {
  organization: Organization;
  connectionId: string | null;
  current: boolean;
  myUserId: string | null;
  onChanged: () => void;
  onSignInRequired: (reason: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const admin = organization.role === 'admin' && organization.pausedAt === null;
  const connection = organization.connection;

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const invited = await postJson(
        '/api/organizations/invite',
        { orgId: organization.orgId, email: email.trim(), role },
        invitedSchema,
      );
      setInviteUrl(invited.inviteUrl);
      setMessage(
        invited.emailed
          ? `Invite sent to ${email.trim()}. You can also share the link below.`
          : "The invite email couldn't be sent; share the link below instead.",
      );
      setEmail('');
      onChanged();
    } catch (inviteError) {
      setMessage(messageOf(inviteError instanceof Error ? inviteError : null, 'Unable to invite.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-bolt-elements-borderColor p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate font-medium">{organization.orgName}</h3>
        <span className="text-xs text-content-secondary">{organization.pausedAt ? 'paused' : organization.role}</span>
        {connectionId && !current ? (
          <Button size="xs" variant="neutral" onClick={() => void switchWorkspace(connectionId)}>
            Open
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-content-secondary">
        {connection === null
          ? 'No Cloudflare account connected yet.'
          : connection.active
            ? `Builds in ${connection.accountName ?? 'its Cloudflare account'}.`
            : 'Its Cloudflare connection needs an admin to reconnect it.'}
      </p>
      {admin ? (
        <>
          {/* Also there once connected: reconnecting is how an admin grants permissions it later needs. */}
          <Button
            className="mt-2"
            size="xs"
            variant={connection?.active ? 'neutral' : 'primary'}
            // A refusal is shown, not dropped; an admin who signed in too long ago is offered a fresh sign-in.
            onClick={() =>
              void run(
                () => connectOrganization(organization.orgId, onSignInRequired),
                () => undefined,
                setMessage,
              )
            }
          >
            {connection?.active ? 'Reconnect its Cloudflare account' : 'Connect its Cloudflare account'}
          </Button>
          <OrgProjectsSection
            orgId={organization.orgId}
            github={organization.github}
            projects={organization.projects}
            members={organization.members ?? []}
            productionRequests={organization.productionRequests ?? []}
            onChanged={onChanged}
            onMessage={setMessage}
            onSignInRequired={onSignInRequired}
          />
          <h4 className="mt-3 text-sm font-medium">People</h4>
          <ul className="mt-2 grid gap-2 text-sm">
            {organization.members?.map((member) => (
              <MemberRow
                key={member.userId}
                orgId={organization.orgId}
                member={member}
                onChanged={onChanged}
                onMessage={setMessage}
              />
            ))}
            {organization.invites?.map((pending) => (
              <li key={pending.id} className="flex flex-wrap items-center gap-2 text-content-secondary">
                <span className="min-w-0 flex-1 truncate">{pending.email}</span>
                <span className="text-xs">invited</span>
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={() =>
                    void run(
                      async () => {
                        await postJson(
                          '/api/organizations/invite/revoke',
                          { orgId: organization.orgId, inviteId: pending.id },
                          noContentSchema,
                        );
                      },
                      onChanged,
                      setMessage,
                    )
                  }
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
          <form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => void invite(event)}>
            <TextInput
              type="email"
              required
              placeholder="name@company.com"
              aria-label="Email to invite"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="min-w-0 flex-1"
            />
            <select
              aria-label="Role"
              value={role}
              onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'member')}
              className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 text-sm"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button type="submit" size="xs" variant="neutral" loading={busy}>
              Invite
            </Button>
          </form>
          {message ? (
            <p className="mt-2 text-sm text-content-secondary" role="status">
              {message}
            </p>
          ) : null}
          {inviteUrl ? (
            <TextInput
              readOnly
              value={inviteUrl}
              aria-label="Invite link"
              className="mt-2 w-full"
              onFocus={(event) => event.target.select()}
            />
          ) : null}
        </>
      ) : (
        <>
          <MyOrgProjects projects={organization.projects} requests={organization.ownRequests} />
          <Button
            className="mt-2"
            size="xs"
            variant="subtle"
            onClick={() =>
              void run(
                async () => {
                  if (myUserId) {
                    await updateMember(organization.orgId, myUserId, 'remove');
                  }
                },
                () => window.location.assign('/settings'),
                setMessage,
              )
            }
          >
            Leave {organization.orgName}
          </Button>
        </>
      )}
      {!admin && message ? (
        <p className="mt-2 text-sm text-content-secondary" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

type Member = NonNullable<Organization['members']>[number];

/** A member in an admin's view: their role and this month's use, and what the admin can change. */
function MemberRow({
  orgId,
  member,
  onChanged,
  onMessage,
}: {
  orgId: string;
  member: Member;
  onChanged: () => void;
  onMessage: (message: string | null) => void;
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const act = (action: MemberAction) =>
    void run(
      async () => {
        const result = await updateMember(orgId, member.userId, action);
        if (result.workspaceDeleted === false) {
          onMessage(
            `${member.email} is removed. Their workspace couldn't be deleted from the Cloudflare account; remove it there.`,
          );
        }
      },
      onChanged,
      onMessage,
    );
  const tokens = member.usage.inputTokens + member.usage.outputTokens;
  return (
    <li className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          {member.name} <span className="text-content-secondary">{member.email}</span>
        </span>
        <span className="text-xs text-content-secondary">{member.pausedAt ? 'paused' : member.role}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-auto text-xs text-content-tertiary">
          This month: {member.usage.turns} {member.usage.turns === 1 ? 'turn' : 'turns'}, {tokens.toLocaleString()}{' '}
          tokens
        </span>
        <Button size="xs" variant="subtle" onClick={() => act(member.pausedAt ? 'resume' : 'pause')}>
          {member.pausedAt ? 'Resume' : 'Pause'}
        </Button>
        {member.role === 'member' ? (
          // Without their own apps, a member works only on the GitHub projects they're given and never
          // gets the organization's Cloudflare authorization.
          <Button
            size="xs"
            variant="subtle"
            onClick={() => act(member.draftsAllowed ? 'disallow_drafts' : 'allow_drafts')}
          >
            {member.draftsAllowed ? 'Only GitHub projects' : 'Allow own apps'}
          </Button>
        ) : null}
        <Button size="xs" variant="subtle" onClick={() => act(member.role === 'admin' ? 'make_member' : 'make_admin')}>
          {member.role === 'admin' ? 'Make member' : 'Make admin'}
        </Button>
        <Button
          size="xs"
          variant={confirmingRemove ? 'danger' : 'subtle'}
          onClick={() => {
            if (confirmingRemove) {
              act('remove');
            }
            setConfirmingRemove(!confirmingRemove);
          }}
        >
          {confirmingRemove ? 'Remove and delete their workspace' : 'Remove'}
        </Button>
      </div>
    </li>
  );
}

function updateMember(orgId: string, userId: string, action: MemberAction) {
  return postJson('/api/organizations/member', { orgId, userId, action }, memberUpdatedSchema);
}

/** Starts connecting an organization's Cloudflare account; a session too old for it is offered a fresh sign-in. */
async function connectOrganization(orgId: string, onSignInRequired: (reason: string) => void): Promise<void> {
  try {
    await signInWithCloudflare(createCloudflareReturnURL(window.location.href), { organizationId: orgId });
  } catch (failure) {
    if (!(failure instanceof ReauthenticationRequiredError)) {
      throw failure;
    }
    onSignInRequired(failure.message);
  }
}
