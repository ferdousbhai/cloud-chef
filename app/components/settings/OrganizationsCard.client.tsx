import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { MenuItem, MenuSeparator } from '@ui/Menu';
import { Modal } from '@ui/Modal';
import { authClient, createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';
import { errorFeedback, FeedbackLine, type Feedback } from './Feedback';
import { OrgProjectsSection, orgGitHubSchema, orgProjectSchema } from './OrgProjectsSection.client';
import { Avatar } from '~/components/showcase/Avatar';
import { getJson, messageOf, postJson, RequestError, runRequest } from '~/lib/json-request';
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
      // Who runs the Cloudflare account it builds in: the space, with one of its own, or CloudChef.
      // The person it was made for (their own Cloudflare account), who stays its admin.
      ownerUserId: z.string().nullable(),
      owner: z.object({ name: z.string(), image: z.string().nullable() }).nullable().catch(null),
      connection: z.object({ accountName: z.string().nullable(), active: z.boolean() }).nullable(),
      members: z
        .array(
          z.object({
            userId: z.string(),
            name: z.string(),
            email: z.string(),
            image: z.string().nullable().catch(null),
            role: roleSchema,
            pausedAt: z.number().nullable(),
            usage: z.object({ turns: z.number(), inputTokens: z.number(), outputTokens: z.number() }),
          }),
        )
        .nullable(),
      github: orgGitHubSchema,
      projects: z.array(orgProjectSchema),
    }),
  ),
});
const memberUpdatedSchema = z.object({ ok: z.literal(true), workspaceDeleted: z.boolean().optional() });
const teamDeletedSchema = z.object({
  deleted: z.literal(true),
  workspacesLeft: z.number(),
  cloudflareAuthorizationRevoked: z.boolean().nullable(),
  cloudflareAuthorizationKept: z.boolean(),
});

/** Where a deleted team's outcome waits across the reload that follows it. */
const TEAM_DELETED_NOTICE_KEY = 'cloudchef:team-deleted';

type MemberAction = 'pause' | 'resume' | 'remove' | 'make_admin' | 'make_member';

type Organization = z.infer<typeof organizationsSchema>['organizations'][number];
type OrgProject = Organization['projects'][number];

/** How many of a member's projects their row names before "and N more". */
const MEMBER_PROJECTS_SHOWN = 3;

/**
 * People: who works on this person's projects, as faces with what each may do, and whose projects this person was
 * added to. Nothing here names an account: the Cloudflare account their projects build in is one quiet line below
 * the people, and their projects follow it. Someone joins by having a project shared with them; whoever's projects
 * they are may let one of them do everything.
 */
export function OrganizationsCard() {
  const { data: session } = authClient.useSession();
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      getJson('/api/organizations', organizationsSchema, 'Unable to load your spaces.').then(
        ({ organizations }) => {
          setOrganizations(organizations);
          setError(null);
        },
        (loadError) => setError(messageOf(loadError, 'Unable to load your spaces.')),
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

  return (
    <SettingsCard id="organizations" title="People" description="Who works on your projects, and whose you work on.">
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
        <p className="mt-4 text-sm text-content-secondary">
          You have nowhere to build yet. Connect your Cloudflare account on the home page.
        </p>
      ) : null}
      <div className="mt-4 grid min-w-0 gap-3">
        {organizations?.map((organization) => (
          <OrganizationRow
            key={organization.orgId}
            organization={organization}
            // What they call it and the connection to open: the session lists the spaces they may build in now.
            name={organization.orgName}
            myUserId={session?.user.id ?? null}
            onChanged={reload}
          />
        ))}
      </div>
    </SettingsCard>
  );
}

function OrganizationRow({
  organization,
  name,
  myUserId,
  onChanged,
}: {
  organization: Organization;
  /** What this person calls it: Personal while it is theirs alone. */
  name: string;
  myUserId: string | null;
  onChanged: () => Promise<void>;
}) {
  const [peopleFeedback, setPeopleFeedback] = useState<Feedback>(null);
  const [connectFeedback, setConnectFeedback] = useState<Feedback>(null);
  const [dialog, setDialog] = useState<'delete' | 'leave' | null>(null);
  const admin = organization.role === 'admin' && organization.pausedAt === null;
  const connection = organization.connection;
  const projects = organization.projects;
  // Made for this person: it is theirs, whoever else is in it.
  const mine = myUserId !== null && organization.ownerUserId === myUserId;

  const connectCloudflare = () =>
    void runRequest(
      async () => {
        await signInWithCloudflare(createCloudflareReturnURL(window.location.href), {
          organizationId: organization.orgId,
        });
      },
      (message) => setConnectFeedback(errorFeedback(message)),
    );

  const others = (organization.members ?? []).filter((member) => member.userId !== myUserId);
  const cloudflare = (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <span className="text-content-secondary">Cloudflare</span>
      {connection === null ? (
        <StatusBadge tone="warning">Not connected</StatusBadge>
      ) : connection.active ? (
        <StatusBadge tone="success">{connection.accountName ?? 'Connected'}</StatusBadge>
      ) : (
        <StatusBadge tone="warning">Needs reconnecting</StatusBadge>
      )}
      <span className="ml-auto flex items-center gap-1">
        {!connection?.active ? (
          <Button size="xs" variant="primary" onClick={connectCloudflare}>
            Connect Cloudflare
          </Button>
        ) : null}
        <MoreMenu title="More for Cloudflare">
          {/* Reconnecting is how CloudChef is given permissions it later needs. */}
          {connection?.active ? <MenuItem action={connectCloudflare}>Reconnect</MenuItem> : null}
          <MenuSeparator />
          <MenuItem danger action={() => setDialog('delete')}>
            {mine ? 'Disconnect Cloudflare' : 'Delete'}
          </MenuItem>
        </MoreMenu>
      </span>
    </div>
  );
  return (
    <div className="min-w-0">
      {admin ? (
        <>
          {others.length === 0 ? (
            <p className="text-sm text-content-secondary">
              Nobody else yet. To work on a project with someone, share it with them from its menu.
            </p>
          ) : (
            <ul className="grid min-w-0 divide-y divide-bolt-elements-borderColor">
              {others.map((member) => (
                <MemberRow
                  key={member.userId}
                  orgId={organization.orgId}
                  member={member}
                  projects={projects}
                  onChanged={onChanged}
                  onFeedback={setPeopleFeedback}
                />
              ))}
            </ul>
          )}
          <FeedbackLine feedback={peopleFeedback} className="" />
          <div className="mt-5 border-t border-bolt-elements-borderColor pt-4">{cloudflare}</div>
          <FeedbackLine feedback={connectFeedback} />
          <OrgProjectsSection
            orgId={organization.orgId}
            github={organization.github}
            projects={projects}
            members={organization.members ?? []}
            onChanged={onChanged}
          />
        </>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-3 border-t border-bolt-elements-borderColor pt-4">
          <Avatar name={organization.owner?.name ?? name} image={organization.owner?.image ?? null} size={32} />
          <div className="min-w-0 flex-1 basis-48 text-sm">
            <p className="truncate">
              {organization.owner?.name ?? name}
              {organization.pausedAt ? <span className="text-content-tertiary"> · paused</span> : null}
            </p>
            <p className="text-xs text-content-tertiary wrap-anywhere">
              {projects.length > 0
                ? `Shared ${projects.map((project) => project.name).join(', ')} with you`
                : 'Nothing shared with you now'}
            </p>
          </div>
          {myUserId ? (
            <Button size="xs" variant="subtle" onClick={() => setDialog('leave')}>
              Leave
            </Button>
          ) : null}
        </div>
      )}
      {dialog === 'delete' ? (
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
        intro={`You're the only one in ${orgName}, so leaving deletes it.`}
        onCancel={onCancel}
      />
    );
  }
  return (
    <Modal title={`Leave ${orgName}?`} onClose={leaving ? undefined : onCancel}>
      <div className="grid gap-3 text-sm text-content-secondary">
        <p>
          Your workspace in its Cloudflare account, with your chats and project files there, is deleted. To come back,
          someone there shares a project with you again.
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
          ? ['CloudChef kept its access to the Cloudflare account, because someone still builds in it outside it.']
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
        setFeedback(errorFeedback(messageOf(deleteError, 'Unable to delete it.')));
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
          members, projects and usage are removed from CloudChef, and CloudChef&apos;s access to the Cloudflare account
          is revoked, unless someone still builds in it outside it. This can&apos;t be undone.
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
  member,
  projects,
  onChanged,
  onFeedback,
}: {
  orgId: string;
  member: Member;
  projects: OrgProject[];
  onChanged: () => Promise<void>;
  onFeedback: (feedback: Feedback) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // One change at a time: a second click while one is in flight would repeat it.
  const [busy, setBusy] = useState(false);
  // Removing someone deletes their workspace, so it asks for a sign-in within the last few minutes, as
  // deleting the team does.
  const [reauthenticate, setReauthenticate] = useState(false);
  const who = member.name || member.email;
  const cancel = () => {
    setConfirming(false);
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
    setConfirming(false);
    await onChanged();
    setBusy(false);
  };
  const tokens = member.usage.inputTokens + member.usage.outputTokens;
  const everything = member.role === 'admin';
  const theirs = projects.flatMap((project) => {
    const grant = project.access.find(({ userId }) => userId === member.userId);
    return grant ? [{ id: project.id, name: project.name, role: grant.role }] : [];
  });
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <Avatar name={who} image={member.image} size={36} />
      <div className="min-w-0 flex-1 basis-48">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 truncate">{who}</span>
          {member.pausedAt ? <StatusBadge tone="warning">Paused</StatusBadge> : null}
        </p>
        <p className="mt-1 flex min-w-0 flex-wrap gap-1 text-xs">
          {everything ? (
            <span className="rounded-full bg-bolt-elements-background-depth-3 px-2 py-0.5 text-content-secondary">
              Can do everything
            </span>
          ) : theirs.length === 0 ? (
            <span className="text-content-tertiary">On no project now</span>
          ) : (
            theirs.slice(0, MEMBER_PROJECTS_SHOWN).map((project) => (
              <span
                key={project.id}
                className="max-w-full truncate rounded-full bg-bolt-elements-background-depth-3 px-2 py-0.5 text-content-secondary"
              >
                {project.name} · {project.role === 'edit' ? 'can edit' : 'can view'}
              </span>
            ))
          )}
          {!everything && theirs.length > MEMBER_PROJECTS_SHOWN ? (
            <span className="px-1 py-0.5 text-content-tertiary">+{theirs.length - MEMBER_PROJECTS_SHOWN} more</span>
          ) : null}
        </p>
        <p className="mt-1 truncate text-xs text-content-tertiary" title={member.email}>
          {member.name ? `${member.email} · ` : ''}
          {member.usage.turns} {member.usage.turns === 1 ? 'turn' : 'turns'}, {compactCount(tokens)} tokens this month
        </p>
      </div>
      <MoreMenu title={`Manage ${who}`}>
        <MenuItem action={() => void act(member.pausedAt ? 'resume' : 'pause')}>
          {member.pausedAt ? 'Resume' : 'Pause'}
        </MenuItem>
        <MenuItem action={() => void act(everything ? 'make_member' : 'make_admin')}>
          {everything ? 'Limit to their projects' : 'Let them do everything'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger action={() => setConfirming(true)}>
          Remove
        </MenuItem>
      </MoreMenu>
      {confirming ? (
        <Modal title={`Remove ${who}?`} onClose={busy ? undefined : cancel}>
          <div className="grid gap-3 text-sm text-content-secondary">
            <p>
              They come off every project of yours, and their workspace in your Cloudflare account, with their chats and
              project files there, is deleted.
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
              <Button size="sm" variant="danger" loading={busy} onClick={() => void act('remove')}>
                Remove and delete their workspace
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
