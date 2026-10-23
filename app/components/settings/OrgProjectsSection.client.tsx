import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { createCloudflareReturnURL } from '~/lib/auth-client';
import { errorFeedback, FeedbackLine, noteFeedback, type Feedback } from './Feedback';
import { getJson, noContentSchema, postJson, runRequest } from '~/lib/json-request';

export const orgGitHubSchema = z.object({ accountLogin: z.string(), accountType: z.string() }).nullable();
export const orgProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The project's Artifacts repository; null until it is first opened, which imports it. */
  repo: z.string().nullable(),
  origin: z.enum(['imported', 'promoted']),
  /** The GitHub repository it was imported from. */
  importRepoFullName: z.string().nullable(),
  access: z.array(z.object({ userId: z.string(), role: z.enum(['view', 'edit']) })),
});
export const productionRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string().nullable(),
  previewUrl: z.string().nullable(),
  repo: z.string().nullable(),
  commit: z.string().nullable(),
  requesterName: z.string(),
  requesterEmail: z.string(),
  updatedAt: z.number().nullable(),
});
export const ownRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'approved', 'declined']),
  decisionNote: z.string().nullable(),
});

type ProductionRequest = z.infer<typeof productionRequestSchema>;
const approvedSchema = z.object({
  projectId: z.string(),
  repo: z.string(),
  workersBuilds: z.object({ namespace: z.string(), repo: z.string(), connectUrl: z.string() }),
});

/** Where an admin connects a project's repository to Workers Builds, which then deploys it. */
const WORKERS_BUILDS_CONNECT_URL = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages';

type OrgProject = z.infer<typeof orgProjectSchema>;
type ProjectMember = { userId: string; name: string; email: string; role: 'admin' | 'member' };

const installStartedSchema = z.object({ installUrl: z.string() });
const repositoriesSchema = z.object({
  repositories: z.array(
    z.object({ id: z.number(), fullName: z.string(), defaultBranch: z.string(), private: z.boolean() }),
  ),
});
const linkedSchema = z.object({ projectId: z.string() });

type Repository = z.infer<typeof repositoriesSchema>['repositories'][number];

/**
 * An admin's view of an organization's GitHub projects: the GitHub account CloudChef's App is installed
 * on, the repositories linked as projects, and which members may work on each. Admins work on all of them.
 */
export function OrgProjectsSection({
  orgId,
  github,
  projects,
  members,
  productionRequests,
  onChanged,
}: {
  orgId: string;
  github: z.infer<typeof orgGitHubSchema>;
  projects: OrgProject[];
  members: ProjectMember[];
  productionRequests: ProductionRequest[];
  onChanged: () => Promise<void>;
}) {
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [listing, setListing] = useState(false);
  const [repoId, setRepoId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const onError = (message: string | null) => setFeedback(errorFeedback(message));
  const linkedIds = new Set(projects.map((project) => project.importRepoFullName));
  const contributors = members.filter((member) => member.role === 'member');
  const unlinked = repositories?.filter((repository) => !linkedIds.has(repository.fullName)) ?? [];

  const connect = () =>
    void runRequest(async () => {
      const { installUrl } = await postJson(
        '/api/organizations/github/start',
        { orgId, callbackURL: createCloudflareReturnURL(window.location.href) },
        installStartedSchema,
      );
      window.location.assign(installUrl);
    }, onError);

  const chooseRepository = async () => {
    setListing(true);
    await runRequest(async () => {
      const listed = await getJson(
        `/api/organizations/github/repositories?orgId=${encodeURIComponent(orgId)}`,
        repositoriesSchema,
      );
      setRepositories(listed.repositories);
    }, onError);
    setListing(false);
  };

  const link = async (event: FormEvent) => {
    event.preventDefault();
    const repository = repositories?.find((candidate) => String(candidate.id) === repoId);
    if (!repository) {
      return;
    }
    setBusy(true);
    await runRequest(async () => {
      await postJson(
        '/api/projects/import',
        { orgId, repoId: repository.id, name: name.trim() || repository.fullName.split('/')[1] },
        linkedSchema,
      );
      setRepositories(null);
      setRepoId('');
      setName('');
      setFeedback(noteFeedback(`Imported ${repository.fullName}. Its code comes over when it is first opened.`));
      await onChanged();
    }, onError);
    setBusy(false);
  };

  const disconnect = () =>
    void runRequest(async () => {
      await postJson('/api/organizations/github/disconnect', { orgId }, noContentSchema);
      setConfirmingDisconnect(false);
      await onChanged();
    }, onError);

  return (
    <div className="mt-3 grid min-w-0 gap-2 text-sm">
      <h4 className="font-medium">Projects</h4>
      {github === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 text-content-secondary">
            Connect GitHub to let people work on repositories here; each one deploys through its own pipeline.
          </span>
          <Button size="xs" variant="neutral" onClick={connect}>
            Connect GitHub
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-content-secondary [overflow-wrap:anywhere]">
            Repositories from github.com/{github.accountLogin}
          </span>
          {confirmingDisconnect ? (
            <>
              <span className="min-w-0 basis-full text-xs text-content-secondary">
                Disconnect GitHub? Linked projects stay listed, but nobody can open them until it&apos;s connected
                again.
              </span>
              <Button size="xs" variant="danger" onClick={disconnect}>
                Disconnect GitHub
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setConfirmingDisconnect(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="xs" variant="subtle" onClick={connect}>
                Change repositories
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setConfirmingDisconnect(true)}>
                Disconnect
              </Button>
            </>
          )}
        </div>
      )}
      {productionRequests.length > 0 ? (
        <ul className="grid gap-2" aria-label="Production requests">
          {productionRequests.map((pending) => (
            <ProductionRequestRow
              key={pending.id}
              orgId={orgId}
              pending={pending}
              onChanged={onChanged}
              onFeedback={setFeedback}
            />
          ))}
        </ul>
      ) : null}
      <ul className="grid gap-2">
        {projects.map((project) => (
          <ProjectRow
            key={project.id}
            orgId={orgId}
            project={project}
            contributors={contributors}
            onChanged={onChanged}
            onError={onError}
          />
        ))}
      </ul>
      {github !== null && repositories === null ? (
        <Button
          className="justify-self-start"
          size="xs"
          variant="neutral"
          loading={listing}
          onClick={() => void chooseRepository()}
        >
          Link a repository
        </Button>
      ) : null}
      {repositories !== null && unlinked.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-content-secondary">
            Every repository CloudChef&apos;s GitHub App reaches is linked already. Use Change repositories to give it
            more.
          </span>
          <Button size="xs" variant="subtle" onClick={() => setRepositories(null)}>
            Close
          </Button>
        </div>
      ) : null}
      {repositories !== null && unlinked.length > 0 ? (
        <form className="flex flex-wrap gap-2" onSubmit={(event) => void link(event)}>
          <select
            required
            aria-label="Repository"
            value={repoId}
            onChange={(event) => setRepoId(event.target.value)}
            className="min-w-0 max-w-full flex-1 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 text-sm"
          >
            <option value="">Choose a repository</option>
            {unlinked.map((repository) => (
              <option key={repository.id} value={String(repository.id)}>
                {repository.fullName}
              </option>
            ))}
          </select>
          <TextInput
            maxLength={80}
            placeholder="Project name"
            aria-label="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="xs" variant="neutral" loading={busy} disabled={!repoId}>
            Link
          </Button>
          <Button size="xs" variant="subtle" onClick={() => setRepositories(null)}>
            Cancel
          </Button>
        </form>
      ) : null}
      <FeedbackLine feedback={feedback} className="" />
    </div>
  );
}

function ProjectRow({
  orgId,
  project,
  contributors,
  onChanged,
  onError,
}: {
  orgId: string;
  project: OrgProject;
  contributors: ProjectMember[];
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  // Access being saved, shown as asked until the refreshed list arrives.
  const [saving, setSaving] = useState<ReadonlyMap<string, boolean>>(new Map());
  const allowed = new Set(project.access.map((grant) => grant.userId));
  const setAccess = async (userId: string, granted: boolean) => {
    setSaving((current) => new Map(current).set(userId, granted));
    await runRequest(async () => {
      await postJson(
        '/api/organizations/projects/access',
        { orgId, projectId: project.id, userId, role: granted ? 'edit' : null },
        noContentSchema,
      );
      await onChanged();
    }, onError);
    setSaving((current) => {
      const next = new Map(current);
      next.delete(userId);
      return next;
    });
  };
  const unlink = () =>
    void runRequest(async () => {
      await postJson('/api/organizations/projects/unlink', { orgId, projectId: project.id }, noContentSchema);
      await onChanged();
    }, onError);
  return (
    <li className="grid min-w-0 gap-1 rounded-md border border-bolt-elements-borderColor p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate" title={project.importRepoFullName ?? project.repo ?? project.name}>
          {project.name}{' '}
          {project.importRepoFullName ? (
            <a
              className="text-content-secondary underline"
              href={`https://github.com/${project.importRepoFullName}`}
              title={project.importRepoFullName}
              target="_blank"
              rel="noopener noreferrer"
            >
              {project.importRepoFullName}
            </a>
          ) : (
            <span className="text-content-secondary">{project.repo}</span>
          )}
        </span>
        {confirmingUnlink ? (
          <>
            <Button
              size="xs"
              variant="danger"
              aria-label={`Unlink (the repository stays on GitHub): ${project.name}`}
              onClick={unlink}
            >
              Unlink (the repository stays on GitHub)
            </Button>
            <Button size="xs" variant="subtle" onClick={() => setConfirmingUnlink(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            variant="subtle"
            aria-label={`Unlink ${project.name}`}
            onClick={() => setConfirmingUnlink(true)}
          >
            Unlink
          </Button>
        )}
      </div>
      {project.origin === 'promoted' ? <WorkersBuildsConnect repo={project.repo ?? ''} /> : null}
      {contributors.length > 0 ? (
        <div
          className="flex flex-wrap gap-3 text-xs text-content-secondary"
          role="group"
          aria-label={`Who may work on ${project.name}`}
        >
          {contributors.map((member) => (
            <label key={member.userId} className="flex min-w-0 items-center gap-1 [overflow-wrap:anywhere]">
              <input
                type="checkbox"
                aria-label={`${member.name || member.email} may work on ${project.name}`}
                checked={saving.get(member.userId) ?? allowed.has(member.userId)}
                disabled={saving.has(member.userId)}
                onChange={(event) => void setAccess(member.userId, event.target.checked)}
              />
              {member.name || member.email}
            </label>
          ))}
        </div>
      ) : (
        <span className="text-xs text-content-tertiary">Invite members to give them this project.</span>
      )}
    </li>
  );
}

/** How an admin connects a project's repository to Workers Builds, which then deploys its main branch. */
function WorkersBuildsConnect({ repo }: { repo: string }) {
  return (
    <p className="text-xs text-content-secondary [overflow-wrap:anywhere]">
      To deploy it, open{' '}
      <a className="underline" href={WORKERS_BUILDS_CONNECT_URL} target="_blank" rel="noopener noreferrer">
        Workers &amp; Pages
      </a>
      , choose Create, then Continue with Artifacts, and pick the namespace <code>cloudchef</code> and the repository{' '}
      <code>{repo}</code>. It deploys from <code>main</code>; turn on builds for Preview branches.
    </p>
  );
}

/** A member's request to make a draft a real project, as an admin decides it. */
function ProductionRequestRow({
  orgId,
  pending,
  onChanged,
  onFeedback,
}: {
  orgId: string;
  pending: ProductionRequest;
  onChanged: () => Promise<void>;
  onFeedback: (feedback: Feedback) => void;
}) {
  const [approving, setApproving] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [decisionNote, setDecisionNote] = useState('');
  const onError = (message: string | null) => onFeedback(errorFeedback(message));
  const approve = async () => {
    setApproving(true);
    await runRequest(async () => {
      const approved = await postJson(
        '/api/organizations/production-requests/approve',
        { orgId, requestId: pending.id },
        approvedSchema,
      );
      onFeedback(
        noteFeedback(
          `${pending.title} is now a team project. To deploy it, connect the repository ${approved.workersBuilds.repo} ` +
            `(namespace ${approved.workersBuilds.namespace}) to Workers Builds.`,
        ),
      );
      await onChanged();
    }, onError);
    setApproving(false);
  };
  const decline = () =>
    void runRequest(async () => {
      await postJson(
        '/api/organizations/production-requests/decline',
        { orgId, requestId: pending.id, note: decisionNote.trim() },
        noContentSchema,
      );
      onFeedback(noteFeedback(`Declined ${pending.title}.`));
      await onChanged();
    }, onError);
  return (
    <li className="grid min-w-0 gap-1 rounded-md border border-bolt-elements-borderColor p-2 [overflow-wrap:anywhere]">
      <span>
        <strong>{pending.title}</strong>{' '}
        <span className="text-content-secondary">
          from {pending.requesterName || pending.requesterEmail} wants to go to production
        </span>
        {pending.updatedAt ? (
          <span className="text-xs text-content-tertiary"> · updated {timeAgo(pending.updatedAt)}</span>
        ) : null}
      </span>
      {pending.note ? <span className="text-xs text-content-secondary">{pending.note}</span> : null}
      {pending.previewUrl ? (
        <a className="text-xs underline" href={pending.previewUrl} target="_blank" rel="noopener noreferrer">
          Try the draft
        </a>
      ) : null}
      {declining ? (
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            maxLength={1_000}
            placeholder="Why, for them (optional)"
            aria-label={`Note to ${pending.requesterName || pending.requesterEmail} about ${pending.title}`}
            value={decisionNote}
            onChange={(event) => setDecisionNote(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button size="xs" variant="danger" aria-label={`Decline request: ${pending.title}`} onClick={decline}>
            Decline request
          </Button>
          <Button size="xs" variant="subtle" onClick={() => setDeclining(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="primary"
            loading={approving}
            aria-label={`Approve: ${pending.title}`}
            onClick={() => void approve()}
          >
            Approve
          </Button>
          <Button
            size="xs"
            variant="subtle"
            disabled={approving}
            aria-label={`Decline ${pending.title}`}
            onClick={() => setDeclining(true)}
          >
            Decline
          </Button>
        </div>
      )}
    </li>
  );
}

/** A member's list of the projects they were given in an organization. */
export function MyOrgProjects({
  projects,
  requests,
}: {
  projects: OrgProject[];
  requests: z.infer<typeof ownRequestSchema>[];
}) {
  return (
    <>
      {projects.length > 0 ? (
        <p className="mt-2 text-sm text-content-secondary [overflow-wrap:anywhere]">
          Your projects: {projects.map((project) => project.name).join(', ')}
        </p>
      ) : null}
      {requests.length > 0 ? (
        <ul
          className="mt-2 grid gap-1 text-sm text-content-secondary [overflow-wrap:anywhere]"
          aria-label="Your production requests"
        >
          {requests.map((request) => (
            <li key={request.id}>
              {request.title}:{' '}
              {request.status === 'pending'
                ? 'waiting for an admin'
                : request.status === 'approved'
                  ? 'approved, now a project'
                  : `declined${request.decisionNote ? ` (${request.decisionNote})` : ''}`}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** How long ago a moment was, roughly: "just now", "5 min ago", "3 h ago", "2 days ago". */
function timeAgo(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
