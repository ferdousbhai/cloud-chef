import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { PlusIcon } from '@radix-ui/react-icons';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { MenuItem, MenuSeparator } from '@ui/Menu';
import { Modal } from '@ui/Modal';
import { TextInput } from '@ui/TextInput';
import { authClient, createCloudflareReturnURL, refreshSession, signInWithCloudflare } from '~/lib/auth-client';
import { switchAccount } from '~/lib/account-actions.client';
import { errorFeedback, FeedbackLine, noteFeedback, type Feedback } from './Feedback';
import { MyOrgProjects, OrgProjectsSection, orgGitHubSchema, orgProjectSchema } from './OrgProjectsSection.client';
import { getJson, messageOf, noContentSchema, postJson, RequestError, runRequest } from '~/lib/json-request';
import { ReauthenticatePrompt } from './ReauthenticatePrompt';
import { gitHubReturnMessageText } from '~/lib/github-return-messages';
import { MoreMenu, SettingsCard, StatusBadge } from './SettingsLayout';

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
      invites: z
        .array(
          z.object({
            id: z.string(),
            email: z.string(),
            role: roleSchema,
            projectIds: z.array(z.string()),
            draftsAllowed: z.boolean(),
          }),
        )
        .nullable(),
      github: orgGitHubSchema,
      projects: z.array(orgProjectSchema),
    }),
  ),
});
const createdSchema = z.object({ orgId: z.string() });
const invitedSchema = z.object({ inviteUrl: z.string(), emailed: z.boolean() });
const memberUpdatedSchema = z.object({ ok: z.literal(true), workspaceDeleted: z.boolean().optional() });
const teamDeletedSchema = z.object({
  deleted: z.literal(true),
  workspacesLeft: z.number(),
  cloudflareAuthorizationRevoked: z.boolean().nullable(),
  cloudflareAuthorizationKept: z.boolean(),
});

/** Where a deleted team's outcome waits across the reload that follows it. */
const TEAM_DELETED_NOTICE_KEY = 'cloudchef:team-deleted';

type MemberAction = 'pause' | 'resume' | 'remove' | 'make_admin' | 'make_member' | 'allow_drafts' | 'disallow_drafts';

type Organization = z.infer<typeof organizationsSchema>['organizations'][number];
type OrgProject = Organization['projects'][number];

/** How many of a member's projects their row names before "and N more". */
const MEMBER_PROJECTS_SHOWN = 3;

/**
 * Teams: people sharing one Cloudflare account to build in. An admin connects the account and invites
 * people by email; they sign in with Google or an emailed link, without Cloudflare logins.
 */
export function OrganizationsCard() {
  const { data: session } = authClient.useSession();
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // What a return from GitHub (connecting it, or approving a production request) or deleting a team has
  // to say, shown once.
  const [githubMessage] = useState<string | null>(() => {
    const message = new URL(window.location.href).searchParams.get('github_message');
    let deleted: string | null = null;
    try {
      deleted = window.sessionStorage.getItem(TEAM_DELETED_NOTICE_KEY);
    } catch {
      // Without session storage the reload after deleting a team just doesn't repeat what happened.
    }
    return deleted ?? (message ? gitHubReturnMessageText(message) : null);
  });
  const scrolledToHash = useRef(false);
  // Shown once: the address and the stored notice forget it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('github_message')) {
      url.searchParams.delete('github_message');
      url.searchParams.delete('promoted');
      window.history.replaceState(null, '', url);
    }
    try {
      window.sessionStorage.removeItem(TEAM_DELETED_NOTICE_KEY);
    } catch {
      // Nothing stored to forget.
    }
  }, []);

  /** Loads the teams, and again after a change; a failure says so instead of leaving stale controls unexplained. */
  const reload = useCallback(
    () =>
      getJson('/api/organizations', organizationsSchema, 'Unable to load your teams.').then(
        ({ organizations }) => {
          setOrganizations(organizations);
          setError(null);
        },
        (loadError) => setError(messageOf(loadError, 'Unable to load your teams.')),
      ),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Settings opens lazily, so a link to #organizations lands before this card has its height: scroll to
  // it once the organizations are in.
  useEffect(() => {
    if (organizations !== null && !scrolledToHash.current) {
      scrolledToHash.current = true;
      if (window.location.hash === '#organizations') {
        document.getElementById('organizations')?.scrollIntoView();
      }
    }
  }, [organizations]);

  const personal = session?.contexts.find((option) => option.kind === 'personal') ?? null;

  return (
    <SettingsCard
      id="organizations"
      title="Teams"
      description="Share a Cloudflare account with the people you work with."
      action={
        <Button
          size="sm"
          variant={organizations?.length === 0 ? 'primary' : 'neutral'}
          icon={<PlusIcon aria-hidden />}
          onClick={() => setCreating(true)}
        >
          New team
        </Button>
      }
    >
      <FeedbackLine feedback={errorFeedback(error)} className="mt-3" />
      {githubMessage ? (
        <p className="mt-3 text-sm text-content-secondary" role="status">
          {githubMessage}
        </p>
      ) : null}
      {organizations === null && !error ? (
        <p className="mt-3 text-sm text-content-secondary" role="status">
          Loading…
        </p>
      ) : null}
      {organizations?.length === 0 ? (
        <p className="mt-4 text-sm text-content-secondary">You&apos;re not in a team yet.</p>
      ) : null}
      <div className="mt-4 grid min-w-0 gap-3">
        {/* Someone working in a team can always go back to their own account. */}
        {personal && organizations?.length ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-bolt-elements-borderColor px-3 py-2.5">
            <span className="min-w-0 flex-1 truncate text-sm" title={personal.accountName ?? undefined}>
              Personal
              {personal.accountName ? <span className="text-content-tertiary"> · {personal.accountName}</span> : null}
            </span>
            {session?.context?.kind === 'personal' ? (
              <StatusBadge tone="success">Open now</StatusBadge>
            ) : (
              <OpenButton connectionId={personal.connectionId} />
            )}
          </div>
        ) : null}
        {organizations?.map((organization) => (
          <OrganizationRow
            key={organization.orgId}
            organization={organization}
            // The account to open: the session lists the teams this person may build in now.
            connectionId={
              session?.contexts.find((option) => option.kind === 'organization' && option.orgId === organization.orgId)
                ?.connectionId ?? null
            }
            current={session?.context?.kind === 'organization' && session.context.orgId === organization.orgId}
            myUserId={session?.user.id ?? null}
            onChanged={reload}
          />
        ))}
      </div>
      {creating ? <CreateTeamDialog onClose={() => setCreating(false)} onChanged={reload} /> : null}
    </SettingsCard>
  );
}

/** Naming a new team, then straight on to connecting the Cloudflare account it builds in. */
function CreateTeamDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const orgName = name.trim();
    setBusy(true);
    setError(null);
    let created = false;
    try {
      const { orgId } = await postJson('/api/organizations/create', { name: orgName }, createdSchema);
      created = true;
      // It exists now: trying again must not create a second one.
      setName('');
      // Straight on to connecting its Cloudflare account, which only its admin can do.
      await signInWithCloudflare(createCloudflareReturnURL(window.location.href), { organizationId: orgId });
    } catch (createError) {
      const reason = messageOf(createError, 'That did not work.');
      setError(
        created
          ? `Created ${orgName}, but connecting its Cloudflare account didn't start: ${reason} Use Connect Cloudflare on the team.`
          : messageOf(createError, 'Unable to create the team.'),
      );
      setBusy(false);
      void onChanged();
    }
  };
  return (
    <Modal
      title="New team"
      description="You become its admin, then connect the Cloudflare account it builds in. Yours works."
      onClose={onClose}
    >
      <form className="grid gap-3" onSubmit={(event) => void create(event)}>
        <TextInput
          required
          autoFocus
          maxLength={80}
          placeholder="Team name"
          aria-label="Team name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <FeedbackLine feedback={errorFeedback(error)} className="" />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="neutral" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary" loading={busy} className="max-w-full">
            Create and connect Cloudflare
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Opens another account to build in; a refusal is shown as a toast, since the page stays. */
function OpenButton({ connectionId }: { connectionId: string }) {
  const [opening, setOpening] = useState(false);
  const open = async () => {
    setOpening(true);
    if (await switchAccount(connectionId)) {
      setOpening(false);
    }
  };
  return (
    <Button size="xs" variant="neutral" loading={opening} onClick={() => void open()}>
      Open
    </Button>
  );
}

function OrganizationRow({
  organization,
  connectionId,
  current,
  myUserId,
  onChanged,
}: {
  organization: Organization;
  connectionId: string | null;
  current: boolean;
  myUserId: string | null;
  onChanged: () => Promise<void>;
}) {
  const [peopleFeedback, setPeopleFeedback] = useState<Feedback>(null);
  const [connectFeedback, setConnectFeedback] = useState<Feedback>(null);
  const [renaming, setRenaming] = useState(false);
  const [dialog, setDialog] = useState<'invite' | 'delete' | 'leave' | null>(null);
  const admin = organization.role === 'admin' && organization.pausedAt === null;
  const connection = organization.connection;
  const projects = organization.projects;
  const people = (organization.members?.length ?? 0) + (organization.invites?.length ?? 0);

  const connectCloudflare = () =>
    void runRequest(
      async () => {
        await signInWithCloudflare(createCloudflareReturnURL(window.location.href), {
          organizationId: organization.orgId,
        });
      },
      (message) => setConnectFeedback(errorFeedback(message)),
    );

  const revoke = (inviteId: string) =>
    void runRequest(
      async () => {
        await postJson('/api/organizations/invite/revoke', { orgId: organization.orgId, inviteId }, noContentSchema);
        await onChanged();
      },
      (message) => setPeopleFeedback(errorFeedback(message)),
    );

  return (
    <div className="min-w-0 rounded-md border border-bolt-elements-borderColor p-3 sm:p-4">
      {renaming ? (
        <RenameTeam
          orgId={organization.orgId}
          orgName={organization.orgName}
          onDone={async (renamed) => {
            setRenaming(false);
            if (renamed) {
              // The workspace switcher reads team names from the session.
              await Promise.all([onChanged(), refreshSession()]);
            }
          }}
        />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="min-w-0 truncate font-medium" title={organization.orgName}>
            {organization.orgName}
          </h3>
          <StatusBadge tone={organization.pausedAt ? 'warning' : 'neutral'}>
            {organization.pausedAt ? 'Paused' : organization.role === 'admin' ? 'Admin' : 'Member'}
          </StatusBadge>
          {connection === null ? (
            <StatusBadge tone="warning">No Cloudflare account</StatusBadge>
          ) : connection.active ? (
            <StatusBadge tone="success">{connection.accountName ?? 'Cloudflare connected'}</StatusBadge>
          ) : (
            <StatusBadge tone="warning">Cloudflare needs reconnecting</StatusBadge>
          )}
          <span className="ml-auto flex items-center gap-1">
            {current ? (
              <StatusBadge>Open now</StatusBadge>
            ) : connectionId ? (
              <OpenButton connectionId={connectionId} />
            ) : null}
            {admin && !connection?.active ? (
              <Button size="xs" variant="primary" onClick={connectCloudflare}>
                Connect Cloudflare
              </Button>
            ) : null}
            {admin ? (
              <MoreMenu title={`More for ${organization.orgName}`}>
                <MenuItem action={() => setRenaming(true)}>Rename team</MenuItem>
                {/* Reconnecting is how an admin grants permissions CloudChef later needs. */}
                {connection?.active ? (
                  <MenuItem action={connectCloudflare}>Reconnect its Cloudflare account</MenuItem>
                ) : null}
                <MenuSeparator />
                <MenuItem danger action={() => setDialog('delete')}>
                  Delete team
                </MenuItem>
              </MoreMenu>
            ) : myUserId ? (
              <MoreMenu title={`More for ${organization.orgName}`}>
                <MenuItem danger action={() => setDialog('leave')}>
                  Leave team
                </MenuItem>
              </MoreMenu>
            ) : null}
          </span>
        </div>
      )}
      <FeedbackLine feedback={connectFeedback} />
      {admin ? (
        <>
          <div className="mt-4 grid min-w-0 gap-2 text-sm">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h4 className="mr-auto font-medium">
                People <span className="font-normal text-content-tertiary">{people}</span>
              </h4>
              <Button size="xs" variant="neutral" icon={<PlusIcon aria-hidden />} onClick={() => setDialog('invite')}>
                Invite
              </Button>
            </div>
            <ul className="grid min-w-0 divide-y divide-bolt-elements-borderColor rounded-md border border-bolt-elements-borderColor">
              {organization.members?.map((member) => (
                <MemberRow
                  key={member.userId}
                  orgId={organization.orgId}
                  orgName={organization.orgName}
                  member={member}
                  projects={projects}
                  self={member.userId === myUserId}
                  onChanged={onChanged}
                  onFeedback={setPeopleFeedback}
                />
              ))}
              {organization.invites?.map((pending) => (
                <li key={pending.id} className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 basis-40">
                    <span className="block truncate" title={pending.email}>
                      {pending.email}
                    </span>
                    <span className="block text-xs text-content-tertiary">
                      {pending.role}
                      {pending.role === 'member' && pending.projectIds.length > 0
                        ? ` · ${pending.projectIds.length} ${pending.projectIds.length === 1 ? 'project' : 'projects'}`
                        : ''}
                      {pending.role === 'member' && !pending.draftsAllowed ? ' · given projects only' : ''}
                    </span>
                  </span>
                  <StatusBadge>Invited</StatusBadge>
                  <Button
                    size="xs"
                    variant="neutral"
                    aria-label={`Revoke the invite to ${pending.email}`}
                    onClick={() => revoke(pending.id)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
            <FeedbackLine feedback={peopleFeedback} className="" />
          </div>
          <OrgProjectsSection
            orgId={organization.orgId}
            github={organization.github}
            projects={projects}
            members={organization.members ?? []}
            onChanged={onChanged}
          />
        </>
      ) : (
        <MyOrgProjects projects={projects} />
      )}
      {dialog === 'invite' ? (
        <InviteDialog organization={organization} onChanged={onChanged} onClose={() => setDialog(null)} />
      ) : dialog === 'delete' ? (
        <DeleteTeam orgId={organization.orgId} orgName={organization.orgName} onCancel={() => setDialog(null)} />
      ) : dialog === 'leave' && myUserId ? (
        <LeaveOrganization
          orgId={organization.orgId}
          orgName={organization.orgName}
          myUserId={myUserId}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/** Inviting someone by email: their role, whether they may start apps of their own, and their projects. */
function InviteDialog({
  organization,
  onChanged,
  onClose,
}: {
  organization: Organization;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const projects = organization.projects;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  // The projects a new member gets: every project until the admin unticks some.
  const [chosenProjects, setChosenProjects] = useState<ReadonlySet<string> | null>(null);
  const [draftsAllowed, setDraftsAllowed] = useState(true);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const projectIds = chosenProjects ?? new Set(projects.map((project) => project.id));

  const toggleProject = (projectId: string, chosen: boolean) => {
    const next = new Set(projectIds);
    if (chosen) {
      next.add(projectId);
    } else {
      next.delete(projectId);
    }
    setChosenProjects(next);
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const invited = await postJson(
        '/api/organizations/invite',
        {
          orgId: organization.orgId,
          email: email.trim(),
          role,
          // Admins work on every project.
          projectIds:
            role === 'member' ? projects.filter((project) => projectIds.has(project.id)).map(({ id }) => id) : [],
          draftsAllowed: role === 'admin' || draftsAllowed,
        },
        invitedSchema,
      );
      setInviteUrl(invited.inviteUrl);
      setFeedback(
        invited.emailed
          ? noteFeedback(`Invite sent to ${email.trim()}. You can also share this link.`)
          : errorFeedback("The invite email couldn't be sent; share this link instead."),
      );
      setEmail('');
      setChosenProjects(null);
      await onChanged();
    } catch (inviteError) {
      setFeedback(errorFeedback(messageOf(inviteError, 'Unable to invite.')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Invite to ${organization.orgName}`}
      description="They sign in with Google or an emailed link."
      onClose={onClose}
    >
      {inviteUrl ? (
        <div className="grid gap-3">
          <FeedbackLine feedback={feedback} className="" />
          <TextInput
            readOnly
            value={inviteUrl}
            aria-label="Invite link"
            className="w-full"
            onFocus={(event) => event.target.select()}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="neutral" onClick={() => setInviteUrl(null)}>
              Invite someone else
            </Button>
            <Button size="sm" variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form className="grid min-w-0 gap-3 text-sm" onSubmit={(event) => void invite(event)}>
          <div className="flex flex-wrap gap-2">
            <TextInput
              type="email"
              required
              autoFocus
              placeholder="name@company.com"
              aria-label="Email to invite"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="min-w-0 flex-1 basis-48"
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
          </div>
          {role === 'member' ? (
            <>
              {projects.length > 0 ? (
                <fieldset className="grid min-w-0 gap-1 text-content-secondary">
                  <legend className="mb-1 text-content-primary">Projects they get</legend>
                  {projects.map((project) => (
                    <label key={project.id} className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={projectIds.has(project.id)}
                        onChange={(event) => toggleProject(project.id, event.target.checked)}
                      />
                      {project.name}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <label className="flex min-w-0 items-center gap-2 text-content-secondary">
                <input
                  type="checkbox"
                  checked={draftsAllowed}
                  onChange={(event) => setDraftsAllowed(event.target.checked)}
                />
                Can start new apps of their own
              </label>
            </>
          ) : (
            <p className="text-xs text-content-tertiary">Admins work on every project and manage the team.</p>
          )}
          <FeedbackLine feedback={feedback} className="" />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="neutral" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" loading={busy}>
              Send invite
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/**
 * Leaving a team, confirmed in a dialog, since it also deletes the person's workspace (their chats and
 * project files) from the team's Cloudflare account. Settings reloads afterwards, as the account this
 * session builds in may have been the team's.
 */
function LeaveOrganization({
  orgId,
  orgName,
  myUserId,
  onCancel,
}: {
  orgId: string;
  orgName: string;
  myUserId: string;
  onCancel: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // The only one left: leaving would leave the team empty, so it is deleted instead, once confirmed.
  const [soleMember, setSoleMember] = useState(false);
  const leave = async () => {
    setLeaving(true);
    setFeedback(null);
    try {
      await updateMember(orgId, myUserId, 'remove');
      reloadAt('/settings');
    } catch (leaveError) {
      setLeaving(false);
      if (leaveError instanceof RequestError && leaveError.code === 'sole_member') {
        setSoleMember(true);
        return;
      }
      setFeedback(errorFeedback(messageOf(leaveError, 'That did not work. Try again.')));
    }
  };
  if (soleMember) {
    return (
      <DeleteTeam
        orgId={orgId}
        orgName={orgName}
        intro={`You're the only one in ${orgName}, so leaving deletes the team.`}
        onCancel={onCancel}
      />
    );
  }
  return (
    <Modal title={`Leave ${orgName}?`} onClose={leaving ? undefined : onCancel}>
      <div className="grid gap-3 text-sm text-content-secondary">
        <p>
          Your workspace in its Cloudflare account, with your chats and project files there, is deleted. You need a new
          invite to come back.
        </p>
        <FeedbackLine feedback={feedback} className="" />
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="neutral" disabled={leaving} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" loading={leaving} onClick={() => void leave()}>
            Leave and delete my workspace
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** An admin renaming their team, in place of its heading. */
function RenameTeam({
  orgId,
  orgName,
  onDone,
}: {
  orgId: string;
  orgName: string;
  onDone: (renamed: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(orgName);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      await postJson('/api/organizations/rename', { orgId, name: name.trim() }, noContentSchema);
      await onDone(true);
    } catch (renameError) {
      setFeedback(errorFeedback(messageOf(renameError, 'Unable to rename the team.')));
      setSaving(false);
    }
  };
  return (
    <form className="grid min-w-0 gap-1" onSubmit={(event) => void save(event)}>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          required
          autoFocus
          maxLength={80}
          aria-label={`New name for ${orgName}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Button size="xs" variant="subtle" disabled={saving} onClick={() => void onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" size="xs" variant="neutral" loading={saving} disabled={name.trim().length === 0}>
          Save
        </Button>
      </div>
      <FeedbackLine feedback={feedback} className="" />
    </form>
  );
}

/**
 * Deleting a team, confirmed in a dialog, since it can't be undone: what goes, and what stays in the
 * team's Cloudflare and GitHub accounts. Settings reloads afterwards, saying how it went, as this
 * session may have been building in the team's account.
 */
function DeleteTeam({
  orgId,
  orgName,
  intro,
  onCancel,
}: {
  orgId: string;
  orgName: string;
  intro?: string;
  onCancel: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Deleting asks for a sign-in within the last few minutes, as erasing an account does.
  const [reauthenticate, setReauthenticate] = useState(false);
  const remove = async () => {
    setDeleting(true);
    setFeedback(null);
    setReauthenticate(false);
    try {
      const outcome = await postJson('/api/organizations/delete', { orgId }, teamDeletedSchema);
      const notice = [
        `Deleted ${orgName}.`,
        ...(outcome.workspacesLeft > 0
          ? [
              `${outcome.workspacesLeft} ${outcome.workspacesLeft === 1 ? 'workspace' : 'workspaces'} couldn't be deleted from its Cloudflare account; remove ${outcome.workspacesLeft === 1 ? 'it' : 'them'} in the Cloudflare dashboard.`,
            ]
          : []),
        ...(outcome.cloudflareAuthorizationRevoked === false
          ? [
              "CloudChef's access to its Cloudflare account couldn't be revoked. Whoever last connected that account " +
                'to CloudChef can remove it in the Cloudflare dashboard, under Profile, Manage OAuth authorizations.',
            ]
          : []),
        ...(outcome.cloudflareAuthorizationKept
          ? [
              'CloudChef kept its access to the Cloudflare account, because someone still builds in it outside this team.',
            ]
          : []),
      ].join(' ');
      try {
        window.sessionStorage.setItem(TEAM_DELETED_NOTICE_KEY, notice);
      } catch {
        // Settings still reloads without the team; it just doesn't say how the deletion went.
      }
      reloadAt('/settings#organizations');
    } catch (deleteError) {
      if (deleteError instanceof RequestError && deleteError.code === 'reauthentication_required') {
        setReauthenticate(true);
      } else {
        setFeedback(errorFeedback(messageOf(deleteError, 'Unable to delete the team.')));
      }
      setDeleting(false);
    }
  };
  return (
    <Modal title={`Delete ${orgName}?`} onClose={deleting ? undefined : onCancel}>
      <div className="grid min-w-0 gap-3 text-sm text-content-secondary">
        {intro ? <p className="text-content-primary">{intro}</p> : null}
        <p>
          Everyone&apos;s workspace in its Cloudflare account, with their chats and project files there, is deleted. Its
          members, invites, projects and usage are removed from CloudChef, and CloudChef&apos;s access to the Cloudflare
          account is revoked, unless someone still builds in it outside this team. This can&apos;t be undone.
        </p>
        <p>
          What stays: each project&apos;s code and history, deployed apps with their databases and storage, and AI
          Gateway keys, in the Cloudflare account; imported repositories, and CloudChef&apos;s GitHub App, on GitHub.
        </p>
        {reauthenticate ? (
          <ReauthenticatePrompt
            reason={`Sign in again to confirm it is you, then return here and delete ${orgName} again.`}
            next={`return here and delete ${orgName} again`}
            onError={(message) => setFeedback(errorFeedback(message))}
          />
        ) : null}
        <FeedbackLine feedback={feedback} className="" />
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="neutral" disabled={deleting} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" loading={deleting} onClick={() => void remove()}>
            Delete {orgName}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

type Member = NonNullable<Organization['members']>[number];

/** Tokens in a few characters: 950, 12k, 3.6M. */
function compactCount(count: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count);
}

/** A member in an admin's view: their role, projects and this month's use, and what the admin can change. */
function MemberRow({
  orgId,
  orgName,
  member,
  projects,
  self,
  onChanged,
  onFeedback,
}: {
  orgId: string;
  orgName: string;
  member: Member;
  projects: OrgProject[];
  /** The admin's own row: no pausing themselves, a confirmed step down, and removal is leaving. */
  self: boolean;
  onChanged: () => Promise<void>;
  onFeedback: (feedback: Feedback) => void;
}) {
  const [confirming, setConfirming] = useState<'remove' | 'make_member' | null>(null);
  // One change at a time: a second click while one is in flight would repeat it.
  const [busy, setBusy] = useState(false);
  // Removing someone deletes their workspace, so it asks for a sign-in within the last few minutes, as
  // deleting the team does.
  const [reauthenticate, setReauthenticate] = useState(false);
  const who = member.name || member.email;
  const cancel = () => {
    setConfirming(null);
    setReauthenticate(false);
  };
  const act = async (action: MemberAction) => {
    setBusy(true);
    onFeedback(null);
    setReauthenticate(false);
    try {
      const result = await updateMember(orgId, member.userId, action);
      if (result.workspaceDeleted === false) {
        onFeedback(
          errorFeedback(
            `${member.email} is removed. Their workspace couldn't be deleted from the Cloudflare account; remove it there.`,
          ),
        );
      }
    } catch (actionError) {
      if (actionError instanceof RequestError && actionError.code === 'reauthentication_required') {
        setReauthenticate(true);
        setBusy(false);
        return;
      }
      // Already gone (removed from another tab, or by another admin): the list catches up below.
      if (!(action === 'remove' && actionError instanceof RequestError && actionError.status === 404)) {
        onFeedback(errorFeedback(messageOf(actionError, 'That did not work. Try again.')));
        setBusy(false);
        return;
      }
    }
    setConfirming(null);
    await onChanged();
    setBusy(false);
  };
  const tokens = member.usage.inputTokens + member.usage.outputTokens;
  const theirProjects = projects.filter((project) => project.access.some((grant) => grant.userId === member.userId));
  const projectsLine =
    member.role === 'admin'
      ? 'all projects'
      : theirProjects.length === 0
        ? 'no projects'
        : `${theirProjects
            .slice(0, MEMBER_PROJECTS_SHOWN)
            .map((project) => project.name)
            .join(', ')}${
            theirProjects.length > MEMBER_PROJECTS_SHOWN
              ? ` and ${theirProjects.length - MEMBER_PROJECTS_SHOWN} more`
              : ''
          }`;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate" title={member.email}>
            {member.name || member.email}
            {self ? <span className="text-content-tertiary"> (you)</span> : null}
          </span>
          {member.pausedAt ? <StatusBadge tone="warning">Paused</StatusBadge> : null}
          {member.role === 'admin' ? <StatusBadge>Admin</StatusBadge> : null}
          {member.role === 'member' && !member.draftsAllowed ? <StatusBadge>Given projects only</StatusBadge> : null}
        </div>
        <p
          className="text-xs text-content-tertiary sm:truncate"
          title={member.role === 'member' ? theirProjects.map((project) => project.name).join(', ') : undefined}
        >
          {member.name ? `${member.email} · ` : ''}
          {projects.length > 0 ? `${projectsLine} · ` : ''}
          {member.usage.turns} {member.usage.turns === 1 ? 'turn' : 'turns'}, {compactCount(tokens)} tokens this month
        </p>
      </div>
      <MoreMenu title={`Manage ${who}`}>
        {self ? null : (
          <MenuItem action={() => void act(member.pausedAt ? 'resume' : 'pause')}>
            {member.pausedAt ? 'Resume' : 'Pause'}
          </MenuItem>
        )}
        {member.role === 'member' ? (
          // Without their own apps, a member works only on the projects they're given and never gets the
          // team's Cloudflare authorization.
          <MenuItem action={() => void act(member.draftsAllowed ? 'disallow_drafts' : 'allow_drafts')}>
            {member.draftsAllowed ? 'Stop new apps of their own' : 'Allow new apps of their own'}
          </MenuItem>
        ) : null}
        <MenuItem
          action={() =>
            member.role === 'admin' && self
              ? setConfirming('make_member')
              : void act(member.role === 'admin' ? 'make_member' : 'make_admin')
          }
        >
          {member.role === 'admin' ? 'Make member' : 'Make admin'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger action={() => setConfirming('remove')}>
          {self ? 'Leave team' : 'Remove from team'}
        </MenuItem>
      </MoreMenu>
      {self && confirming === 'remove' ? (
        <LeaveOrganization orgId={orgId} orgName={orgName} myUserId={member.userId} onCancel={cancel} />
      ) : confirming ? (
        <Modal
          title={confirming === 'remove' ? `Remove ${who}?` : 'Make yourself a member?'}
          onClose={busy ? undefined : cancel}
        >
          <div className="grid gap-3 text-sm text-content-secondary">
            <p>
              {confirming === 'remove'
                ? `Their workspace in ${orgName}'s Cloudflare account, with their chats and project files there, is deleted.`
                : 'You lose admin access to this team until another admin gives it back.'}
            </p>
            {reauthenticate ? (
              <ReauthenticatePrompt
                reason={`Sign in again to confirm it is you, then return here and remove ${who} again.`}
                next={`return here and remove ${who} again`}
                onError={(message) => onFeedback(errorFeedback(message))}
              />
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="neutral" disabled={busy} onClick={cancel}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" loading={busy} onClick={() => void act(confirming)}>
                {confirming === 'remove' ? 'Remove and delete their workspace' : 'Make me a member'}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </li>
  );
}

function updateMember(orgId: string, userId: string, action: MemberAction) {
  return postJson('/api/organizations/member', { orgId, userId, action }, memberUpdatedSchema);
}

/**
 * Loads `href` afresh. Assigning the current page with only a fragment added or changed is a fragment
 * navigation that reloads nothing, so the same page is reloaded instead.
 */
function reloadAt(href: string) {
  const target = new URL(href, window.location.href);
  if (target.pathname !== window.location.pathname || target.search !== window.location.search) {
    window.location.assign(target);
    return;
  }
  window.history.replaceState(null, '', target);
  window.location.reload();
}
