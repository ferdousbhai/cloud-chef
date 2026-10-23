import { useState } from 'react';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { authClient, createCloudflareReturnURL } from '~/lib/auth-client';
import { projectRoleSchema } from '~/lib/cloudflare/org-projects.client';
import { ImportFromGitHubDialog } from '~/components/projects/ImportFromGitHubDialog.client';
import { ProjectAccessList, type ProjectMember } from '~/components/projects/ProjectAccessList.client';
import { openProjectChat } from '~/lib/cloudflare/projects.client';
import { errorFeedback, FeedbackLine, noteFeedback, type Feedback } from './Feedback';
import { noContentSchema, postJson, runRequest } from '~/lib/json-request';

export const orgGitHubSchema = z.object({ accountLogin: z.string(), accountType: z.string() }).nullable();
export const orgProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  origin: z.enum(['imported', 'promoted']),
  /** The project's Artifacts repository; null until the first person to open it has imported it. */
  repo: z.string().nullable(),
  /** The GitHub repository it was imported from, for an imported project. */
  importRepoFullName: z.string().nullable(),
  access: z.array(z.object({ userId: z.string(), role: projectRoleSchema })),
});
export const productionRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string().nullable(),
  previewUrl: z.string().nullable(),
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
const approvedSchema = z.object({ projectId: z.string() });

/** Where an admin connects a team project's repository to Workers Builds, which then deploys it. */
const WORKERS_BUILDS_CREATE_URL = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages/create';

type OrgProject = z.infer<typeof orgProjectSchema>;

const installStartedSchema = z.object({ installUrl: z.string() });

/**
 * An admin's view of a team's projects: each one's repository and who may view or edit it, the members'
 * requests to make a draft a project, and the GitHub account CloudChef's App reads when importing.
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
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [importing, setImporting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const onError = (message: string | null) => setFeedback(errorFeedback(message));
  // Importing acts in the account the person is working in now, so it's offered for that team only.
  const { data: session } = authClient.useSession();
  const workingHere = session?.context?.kind === 'organization' && session.context.orgId === orgId;

  const connect = () =>
    void runRequest(async () => {
      const { installUrl } = await postJson(
        '/api/organizations/github/start',
        { orgId, callbackURL: createCloudflareReturnURL(window.location.href) },
        installStartedSchema,
      );
      window.location.assign(installUrl);
    }, onError);

  const disconnect = () =>
    void runRequest(async () => {
      await postJson('/api/organizations/github/disconnect', { orgId }, noContentSchema);
      setConfirmingDisconnect(false);
      await onChanged();
    }, onError);

  return (
    <div className="mt-3 grid min-w-0 gap-2 text-sm">
      <h4 className="font-medium">Projects</h4>
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
            members={members}
            onChanged={onChanged}
            onError={onError}
          />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {workingHere ? (
          <Button size="xs" variant="neutral" onClick={() => setImporting(true)}>
            Import from GitHub
          </Button>
        ) : (
          <span className="min-w-0 text-content-secondary">Switch to this team to import a project from GitHub.</span>
        )}
      </div>
      {github === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 text-content-secondary">
            Public repositories import from their address. Connect GitHub to import private ones too.
          </span>
          <Button size="xs" variant="subtle" onClick={connect}>
            Connect GitHub
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-48 flex-1 text-content-secondary [overflow-wrap:anywhere]">
            Imports can read repositories from github.com/{github.accountLogin}
          </span>
          {confirmingDisconnect ? (
            <>
              <span className="min-w-0 basis-full text-xs text-content-secondary">
                Disconnect GitHub? Projects already imported stay as they are; only private repositories can&apos;t be
                imported until it&apos;s connected again.
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
      <FeedbackLine feedback={feedback} className="" />
      {importing ? (
        <ImportFromGitHubDialog orgId={orgId} onOpenProject={openProjectChat} onClose={() => setImporting(false)} />
      ) : null}
    </div>
  );
}

function ProjectRow({
  orgId,
  project,
  members,
  onChanged,
  onError,
}: {
  orgId: string;
  project: OrgProject;
  members: ProjectMember[];
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const remove = () =>
    void runRequest(async () => {
      await postJson('/api/organizations/projects/unlink', { orgId, projectId: project.id }, noContentSchema);
      await onChanged();
    }, onError);
  return (
    <li className="grid min-w-0 gap-2 rounded-md border border-bolt-elements-borderColor p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {project.name} <span className="text-xs text-content-secondary">{projectSource(project)}</span>
        </span>
        {confirmingRemove ? (
          <>
            <Button
              size="xs"
              variant="danger"
              aria-label={`Remove from the team (its site stays): ${project.name}`}
              onClick={remove}
            >
              Remove from the team (its site stays)
            </Button>
            <Button size="xs" variant="subtle" onClick={() => setConfirmingRemove(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            variant="subtle"
            aria-label={`Remove ${project.name}`}
            onClick={() => setConfirmingRemove(true)}
          >
            Remove
          </Button>
        )}
      </div>
      {project.origin === 'promoted' ? <WorkersBuildsInstruction /> : null}
      <ProjectAccessList
        orgId={orgId}
        project={project}
        members={members}
        access={project.access}
        onChanged={onChanged}
        onError={onError}
      />
    </li>
  );
}

/** Where a project's code came from, while that still matters: an import not yet made. */
function projectSource(project: OrgProject): string | null {
  if (!project.importRepoFullName) {
    return null;
  }
  return project.repo === null
    ? `imports from github.com/${project.importRepoFullName} when someone first opens it`
    : `imported from github.com/${project.importRepoFullName}`;
}

/** How an admin has Workers Builds deploy a project approved from a draft: the dashboard does it, once. */
function WorkersBuildsInstruction() {
  return (
    <p className="text-xs text-content-secondary">
      To deploy it, connect its repository in{' '}
      <a className="underline" href={WORKERS_BUILDS_CREATE_URL} target="_blank" rel="noopener noreferrer">
        Workers Builds
      </a>
      : Workers &amp; Pages, Create, Continue with Artifacts, then the <code>cloudchef</code> namespace.
    </p>
  );
}

/** A member's request to make a draft a team project, as an admin decides it. */
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
      await postJson(
        '/api/organizations/production-requests/approve',
        { orgId, requestId: pending.id },
        approvedSchema,
      );
      onFeedback(
        noteFeedback(`Approved ${pending.title}. It's a team project now; connect it to Workers Builds to deploy it.`),
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
