import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import {
  authClient,
  createCloudflareReturnURL,
  refreshSession,
  signInWithCloudflare,
  switchWorkspace,
} from '~/lib/auth-client';
import { errorFeedback, FeedbackLine, noteFeedback, type Feedback } from './Feedback';
import {
  MyOrgProjects,
  OrgProjectsSection,
  orgGitHubSchema,
  orgProjectSchema,
  ownRequestSchema,
  productionRequestSchema,
} from './OrgProjectsSection.client';
import { getJson, messageOf, noContentSchema, postJson, RequestError, runRequest } from '~/lib/json-request';
import { ReauthenticateButtons } from './ReauthenticateButtons';
import { gitHubReturnMessageText } from '~/lib/github-return-messages';

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
      productionRequests: z.array(productionRequestSchema).nullable(),
      ownRequests: z.array(ownRequestSchema),
    }),
  ),
});
const createdSchema = z.object({ orgId: z.string() });
const invitedSchema = z.object({ inviteUrl: z.string(), emailed: z.boolean() });
const memberUpdatedSchema = z.object({ ok: z.literal(true), workspaceDeleted: z.boolean().optional() });
const teamDeletedSchema = z.object({
  deleted: z.literal(true),
  workspacesLeft: z.number(),
  cloudflareAuthorizationRevoked: z.boolean(),
});

/** Where a deleted team's outcome waits across the reload that follows it. */
const TEAM_DELETED_NOTICE_KEY = 'cloudchef:team-deleted';

type MemberAction = 'pause' | 'resume' | 'remove' | 'make_admin' | 'make_member' | 'allow_drafts' | 'disallow_drafts';

type Organization = z.infer<typeof organizationsSchema>['organizations'][number];
type OrgProject = Organization['projects'][number];

/** How many of a member's projects their row names before "and N more". */
const MEMBER_PROJECTS_SHOWN = 3;

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
  // What a return from GitHub (connecting it, or approving a production request) or deleting a team has
  // to say, shown once.
  const [githubMessage, setGitHubMessage] = useState<string | null>(null);
  const scrolledToHash = useRef(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    const message = url.searchParams.get('github_message');
    if (message) {
      setGitHubMessage(gitHubReturnMessageText(message));
      url.searchParams.delete('github_message');
      url.searchParams.delete('promoted');
      window.history.replaceState(null, '', url);
    }
    try {
      const deleted = window.sessionStorage.getItem(TEAM_DELETED_NOTICE_KEY);
      if (deleted) {
        window.sessionStorage.removeItem(TEAM_DELETED_NOTICE_KEY);
        setGitHubMessage(deleted);
      }
    } catch {
      // Without session storage the reload after deleting a team just doesn't repeat what happened.
    }
  }, []);

  const load = useCallback(async () => {
    const { organizations } = await getJson('/api/organizations', organizationsSchema, 'Unable to load your teams.');
    setOrganizations(organizations);
    setError(null);
  }, []);

  /** Loads again after a change; a failure says so instead of leaving stale controls unexplained. */
  const reload = useCallback(
    () =>
      load().catch((loadError) => {
        setError(messageOf(loadError, 'Unable to load your teams.'));
      }),
    [load],
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
          ? `Created ${orgName}, but connecting its Cloudflare account didn't start: ${reason} Use its "Connect its Cloudflare account" button below.`
          : messageOf(createError, 'Unable to create the team.'),
      );
      setBusy(false);
      void reload();
    }
  };

  const personal = session?.contexts.find((option) => option.kind === 'personal') ?? null;

  return (
    <section
      id="organizations"
      className="app-card w-full min-w-0 p-4 [overflow-wrap:anywhere]"
      aria-labelledby="organizations-heading"
    >
      <h2 id="organizations-heading" className="app-card-title">
        Teams
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
        <p className="mt-3 text-sm text-content-secondary">
          You&apos;re not in a team yet. Name one below to create it: you become its admin, connect the Cloudflare
          account it builds in (yours works), then invite people and link GitHub repositories.
        </p>
      ) : null}
      <div className="mt-3 grid min-w-0 gap-3">
        {/* Someone working in an organization can always go back to their own account. */}
        {personal && organizations?.length ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-bolt-elements-borderColor p-3">
            <h3 className="min-w-0 flex-1 truncate font-medium" title={personal.accountName ?? undefined}>
              Personal{personal.accountName ? ` · ${personal.accountName}` : ''}
            </h3>
            {session?.context?.kind === 'personal' ? (
              <span className="text-xs text-content-secondary">open now</span>
            ) : (
              <OpenButton connectionId={personal.connectionId} />
            )}
          </div>
        ) : null}
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
            onChanged={reload}
          />
        ))}
      </div>
      <form className="mt-4 flex flex-wrap gap-2" onSubmit={(event) => void create(event)}>
        <TextInput
          required
          maxLength={80}
          placeholder="Team name"
          aria-label="Team name"
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

/** Opens another account to build in; a refusal is shown as a toast, since the page stays. */
function OpenButton({ connectionId }: { connectionId: string }) {
  const [opening, setOpening] = useState(false);
  const open = async () => {
    setOpening(true);
    try {
      await switchWorkspace(connectionId);
    } catch (switchError) {
      toast.error(messageOf(switchError, 'Unable to switch accounts.'));
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
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  // The projects a new member gets: every project until the admin unticks some.
  const [chosenProjects, setChosenProjects] = useState<ReadonlySet<string> | null>(null);
  const [draftsAllowed, setDraftsAllowed] = useState(true);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteFeedback, setInviteFeedback] = useState<Feedback>(null);
  const [peopleFeedback, setPeopleFeedback] = useState<Feedback>(null);
  const [connectFeedback, setConnectFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const admin = organization.role === 'admin' && organization.pausedAt === null;
  const connection = organization.connection;
  const projects = organization.projects;
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
    setInviteFeedback(null);
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
      setInviteFeedback(
        invited.emailed
          ? noteFeedback(`Invite sent to ${email.trim()}. You can also share the link below.`)
          : errorFeedback("The invite email couldn't be sent; share the link below instead."),
      );
      setEmail('');
      setChosenProjects(null);
      await onChanged();
    } catch (inviteError) {
      setInviteFeedback(errorFeedback(messageOf(inviteError, 'Unable to invite.')));
    } finally {
      setBusy(false);
    }
  };

  const revoke = (inviteId: string) =>
    void runRequest(
      async () => {
        await postJson('/api/organizations/invite/revoke', { orgId: organization.orgId, inviteId }, noContentSchema);
      },
      async () => {
        // The link shown is for an invite that may be this one: it no longer works either way.
        setInviteUrl(null);
        setInviteFeedback(null);
        await onChanged();
      },
      (message) => setPeopleFeedback(errorFeedback(message)),
    );

  return (
    <div className="min-w-0 rounded-lg border border-bolt-elements-borderColor p-3">
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
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate font-medium" title={organization.orgName}>
            {organization.orgName}
          </h3>
          <span className="text-xs text-content-secondary">{organization.pausedAt ? 'paused' : organization.role}</span>
          {admin ? (
            <Button
              size="xs"
              variant="subtle"
              aria-label={`Rename ${organization.orgName}`}
              onClick={() => setRenaming(true)}
            >
              Rename
            </Button>
          ) : null}
          {connectionId && !current ? <OpenButton connectionId={connectionId} /> : null}
        </div>
      )}
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
            onClick={() =>
              void runRequest(
                async () => {
                  await signInWithCloudflare(createCloudflareReturnURL(window.location.href), {
                    organizationId: organization.orgId,
                  });
                },
                () => undefined,
                (message) => setConnectFeedback(errorFeedback(message)),
              )
            }
          >
            {connection?.active ? 'Reconnect its Cloudflare account' : 'Connect its Cloudflare account'}
          </Button>
          <FeedbackLine feedback={connectFeedback} />
          <OrgProjectsSection
            orgId={organization.orgId}
            github={organization.github}
            projects={projects}
            members={organization.members ?? []}
            productionRequests={organization.productionRequests ?? []}
            onChanged={onChanged}
          />
          <h4 className="mt-3 text-sm font-medium">People</h4>
          <ul className="mt-2 grid min-w-0 gap-2 text-sm">
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
              <li key={pending.id} className="flex min-w-0 flex-wrap items-center gap-2 text-content-secondary">
                <span className="min-w-0 flex-1 truncate" title={pending.email}>
                  {pending.email}
                </span>
                <span className="text-xs">
                  invited as {pending.role}
                  {pending.role === 'member' && pending.projectIds.length > 0
                    ? ` · ${pending.projectIds.length} ${pending.projectIds.length === 1 ? 'project' : 'projects'}`
                    : ''}
                  {pending.role === 'member' && !pending.draftsAllowed ? ' · GitHub projects only' : ''}
                </span>
                <Button
                  size="xs"
                  variant="subtle"
                  aria-label={`Revoke the invite to ${pending.email}`}
                  onClick={() => revoke(pending.id)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
          <FeedbackLine feedback={peopleFeedback} />
          <form className="mt-3 grid min-w-0 gap-2" onSubmit={(event) => void invite(event)}>
            <div className="flex flex-wrap gap-2">
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
            </div>
            {role === 'member' ? (
              <label className="flex min-w-0 items-center gap-1 text-xs text-content-secondary">
                <input
                  type="checkbox"
                  checked={draftsAllowed}
                  onChange={(event) => setDraftsAllowed(event.target.checked)}
                />
                Can build new apps of their own, not only the projects they get
              </label>
            ) : null}
            {role === 'member' && projects.length > 0 ? (
              <fieldset className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-content-secondary">
                <legend className="mb-1">Projects they get</legend>
                {projects.map((project) => (
                  <label key={project.id} className="flex min-w-0 items-center gap-1" title={project.repoFullName}>
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
          </form>
          <FeedbackLine feedback={inviteFeedback} />
          {inviteUrl ? (
            <TextInput
              readOnly
              value={inviteUrl}
              aria-label="Invite link"
              className="mt-2 w-full"
              onFocus={(event) => event.target.select()}
            />
          ) : null}
          {deleting ? (
            <DeleteTeam orgId={organization.orgId} orgName={organization.orgName} onCancel={() => setDeleting(false)} />
          ) : (
            <Button className="mt-3" size="xs" variant="subtle" onClick={() => setDeleting(true)}>
              Delete {organization.orgName}
            </Button>
          )}
        </>
      ) : (
        <>
          <MyOrgProjects projects={projects} requests={organization.ownRequests} />
          {myUserId ? (
            <LeaveOrganization orgId={organization.orgId} orgName={organization.orgName} myUserId={myUserId} />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Leaving an organization: two steps, since it also deletes the person's workspace (their chats and
 * project files) from the organization's Cloudflare account. Settings reloads afterwards, as the
 * account this session builds in may have been the organization's.
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
  /** Set when asked from elsewhere (an admin's own row): it opens at the confirmation, and Cancel goes back. */
  onCancel?: () => void;
}) {
  const [confirming, setConfirming] = useState(onCancel !== undefined);
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
        onCancel={() => {
          setSoleMember(false);
          if (onCancel) {
            onCancel();
          } else {
            setConfirming(false);
          }
        }}
      />
    );
  }
  return (
    <div className="mt-2 grid min-w-0 gap-1">
      {confirming ? (
        <>
          <p className="text-sm text-content-secondary">
            Leave {orgName}? Your workspace in its Cloudflare account, with your chats and project files there, is
            deleted. You need a new invite to come back.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="danger" loading={leaving} onClick={() => void leave()}>
              Leave and delete my workspace
            </Button>
            <Button size="xs" variant="subtle" disabled={leaving} onClick={onCancel ?? (() => setConfirming(false))}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <Button className="justify-self-start" size="xs" variant="subtle" onClick={() => setConfirming(true)}>
          Leave {orgName}
        </Button>
      )}
      <FeedbackLine feedback={feedback} className="" />
    </div>
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
          maxLength={80}
          aria-label={`New name for ${orgName}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="xs" variant="neutral" loading={saving} disabled={name.trim().length === 0}>
          Save
        </Button>
        <Button size="xs" variant="subtle" disabled={saving} onClick={() => void onDone(false)}>
          Cancel
        </Button>
      </div>
      <FeedbackLine feedback={feedback} className="" />
    </form>
  );
}

/**
 * Deleting a team, confirmed first, since it can't be undone: what goes, and what stays in the team's
 * Cloudflare and GitHub accounts. Settings reloads afterwards, saying how it went, as this session may
 * have been building in the team's account.
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
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
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
        ...(outcome.cloudflareAuthorizationRevoked
          ? []
          : [
              "CloudChef's access to its Cloudflare account couldn't be revoked; revoke it in the Cloudflare dashboard.",
            ]),
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
    <div
      className="mt-3 grid min-w-0 gap-2 text-sm text-content-secondary"
      role="group"
      aria-label={`Delete ${orgName}`}
    >
      {intro ? <p className="text-content-primary">{intro}</p> : null}
      <p>
        Delete {orgName}? Everyone&apos;s workspace in its Cloudflare account, with their chats and project files there,
        is deleted. Its members, invites, linked GitHub projects, production requests and usage are removed from
        CloudChef, and CloudChef&apos;s access to the Cloudflare account is revoked. This can&apos;t be undone.
      </p>
      <p>
        What stays: apps deployed from those workspaces, with their databases and storage, and the account&apos;s AI
        Gateway keys stay in the Cloudflare account; the repositories, and CloudChef&apos;s GitHub App, stay on GitHub
        until you remove them there. To stop CloudChef using the Cloudflare account while keeping the team, revoke its
        access in the Cloudflare dashboard instead; an admin reconnects it here later.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="danger" loading={deleting} onClick={() => void remove()}>
          Delete {orgName}
        </Button>
        <Button size="xs" variant="subtle" disabled={deleting} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {reauthenticate ? (
        <div role="status" className="grid gap-2">
          <p>
            {linkSentTo
              ? `Open the link sent to ${linkSentTo}, then return here and delete ${orgName} again.`
              : `Sign in again to confirm it is you, then return here and delete ${orgName} again.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <ReauthenticateButtons
              onError={(message) => setFeedback(errorFeedback(message))}
              onLinkSent={setLinkSentTo}
            />
          </div>
        </div>
      ) : null}
      <FeedbackLine feedback={feedback} className="" />
    </div>
  );
}

type Member = NonNullable<Organization['members']>[number];

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
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
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
  const theirProjects = projects.filter((project) => project.memberIds.includes(member.userId));
  const projectsLine =
    member.role === 'admin'
      ? 'All projects'
      : theirProjects.length === 0
        ? 'No projects'
        : `Projects: ${theirProjects
            .slice(0, MEMBER_PROJECTS_SHOWN)
            .map((project) => project.name)
            .join(', ')}${
            theirProjects.length > MEMBER_PROJECTS_SHOWN
              ? ` and ${theirProjects.length - MEMBER_PROJECTS_SHOWN} more`
              : ''
          }`;
  return (
    <li className="grid min-w-0 gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate" title={`${member.name} ${member.email}`}>
          {member.name} <span className="text-content-secondary">{member.email}</span>
          {self ? <span className="text-content-secondary"> (you)</span> : null}
        </span>
        <span className="text-xs text-content-secondary">
          {member.pausedAt
            ? 'paused'
            : member.role === 'admin'
              ? 'admin'
              : member.draftsAllowed
                ? 'member · can build new apps'
                : 'member · GitHub projects only'}
        </span>
      </div>
      {projects.length > 0 ? (
        <span
          className="min-w-0 text-xs text-content-secondary"
          title={member.role === 'member' ? theirProjects.map((project) => project.name).join(', ') : undefined}
        >
          {projectsLine}
        </span>
      ) : null}
      {self && confirming === 'remove' ? (
        <LeaveOrganization
          orgId={orgId}
          orgName={orgName}
          myUserId={member.userId}
          onCancel={() => setConfirming(null)}
        />
      ) : confirming ? (
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-auto min-w-0 text-xs text-content-secondary">
              {confirming === 'remove'
                ? `Remove ${member.name || member.email}? Their workspace in the team's account is deleted.`
                : 'Make yourself a member? You lose admin access to this team until another admin gives it back.'}
            </span>
            <Button size="xs" variant="danger" loading={busy} onClick={() => void act(confirming)}>
              {confirming === 'remove' ? 'Remove and delete their workspace' : 'Make me a member'}
            </Button>
            <Button size="xs" variant="subtle" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
          {reauthenticate ? (
            <div role="status" className="grid gap-2 text-xs text-content-secondary">
              <p>
                {linkSentTo
                  ? `Open the link sent to ${linkSentTo}, then return here and remove ${who} again.`
                  : `Sign in again to confirm it is you, then return here and remove ${who} again.`}
              </p>
              <div className="flex flex-wrap gap-2">
                <ReauthenticateButtons
                  onError={(message) => onFeedback(errorFeedback(message))}
                  onLinkSent={setLinkSentTo}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-auto text-xs text-content-tertiary">
            This month: {member.usage.turns} {member.usage.turns === 1 ? 'turn' : 'turns'}, {tokens.toLocaleString()}{' '}
            tokens
          </span>
          {self ? null : (
            <Button
              size="xs"
              variant="subtle"
              disabled={busy}
              aria-label={`${member.pausedAt ? 'Resume' : 'Pause'} ${who}`}
              onClick={() => void act(member.pausedAt ? 'resume' : 'pause')}
            >
              {member.pausedAt ? 'Resume' : 'Pause'}
            </Button>
          )}
          {member.role === 'member' ? (
            // Without their own apps, a member works only on the GitHub projects they're given and never
            // gets the organization's Cloudflare authorization.
            <Button
              size="xs"
              variant="subtle"
              disabled={busy}
              aria-label={`${member.draftsAllowed ? 'Stop new apps for' : 'Allow new apps for'} ${who}`}
              onClick={() => void act(member.draftsAllowed ? 'disallow_drafts' : 'allow_drafts')}
            >
              {member.draftsAllowed ? 'Stop new apps' : 'Allow new apps'}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="subtle"
            disabled={busy}
            aria-label={self ? undefined : `${member.role === 'admin' ? 'Make member' : 'Make admin'}: ${who}`}
            onClick={() =>
              member.role === 'admin' && self
                ? setConfirming('make_member')
                : void act(member.role === 'admin' ? 'make_member' : 'make_admin')
            }
          >
            {member.role === 'admin' ? 'Make member' : 'Make admin'}
          </Button>
          <Button
            size="xs"
            variant="subtle"
            disabled={busy}
            aria-label={self ? undefined : `Remove ${who}`}
            onClick={() => setConfirming('remove')}
          >
            {self ? 'Leave' : 'Remove'}
          </Button>
        </div>
      )}
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
