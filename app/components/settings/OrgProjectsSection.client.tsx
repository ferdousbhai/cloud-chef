import { useState } from 'react';
import { ChevronDownIcon } from '@radix-ui/react-icons';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { ConfirmationDialog } from '@ui/ConfirmationDialog';
import { MenuItem } from '@ui/Menu';
import { TextInput } from '@ui/TextInput';
import { authClient, createCloudflareReturnURL } from '~/lib/auth-client';
import { projectRoleSchema } from '~/lib/cloudflare/org-projects.client';
import { ImportFromGitHubDialog } from '~/components/projects/ImportFromGitHubDialog.client';
import { ProjectAccessList, type ProjectMember } from '~/components/projects/ProjectAccessList.client';
import { openProjectChat } from '~/lib/cloudflare/projects.client';
import { errorFeedback, FeedbackLine, noteFeedback, type Feedback } from './Feedback';
import { noContentSchema, postJson, runRequest } from '~/lib/json-request';
import { MoreMenu, StatusBadge } from './SettingsLayout';

/** The GitHub accounts CloudChef's App is installed on for the team: imports read from all of them. */
export const orgGitHubSchema = z.array(
  z.object({ installationId: z.number(), accountLogin: z.string(), accountType: z.string() }),
);
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
 * requests to make a draft a project, and the GitHub accounts CloudChef's App reads when importing.
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
  const [disconnecting, setDisconnecting] = useState<z.infer<typeof orgGitHubSchema>[number] | null>(null);
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

  const disconnect = (installationId: number) =>
    void runRequest(async () => {
      await postJson('/api/organizations/github/disconnect', { orgId, installationId }, noContentSchema);
      setDisconnecting(null);
      await onChanged();
    }, onError);

  return (
    <div className="mt-5 grid min-w-0 gap-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 className="mr-auto font-medium">
          Projects <span className="font-normal text-content-tertiary">{projects.length}</span>
        </h4>
        <span className="flex items-center gap-1">
          {workingHere ? (
            <Button size="xs" variant="neutral" onClick={() => setImporting(true)}>
              Import from GitHub
            </Button>
          ) : null}
          <MoreMenu title="GitHub for this team">
            {github.length === 0 ? (
              <MenuItem action={connect}>Connect GitHub</MenuItem>
            ) : (
              <>
                <MenuItem action={connect}>Add or change GitHub accounts</MenuItem>
                {github.map((account) => (
                  <MenuItem key={account.installationId} danger action={() => setDisconnecting(account)}>
                    Disconnect {account.accountLogin}
                  </MenuItem>
                ))}
              </>
            )}
          </MoreMenu>
        </span>
      </div>
      {workingHere ? null : (
        <p className="text-xs text-content-tertiary">To import a project from GitHub, open this team first.</p>
      )}
      {productionRequests.length > 0 ? (
        <ul className="grid gap-2" aria-label="Team project requests">
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
      {projects.length > 0 ? (
        <ul className="grid divide-y divide-bolt-elements-borderColor rounded-md border border-bolt-elements-borderColor">
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
      ) : null}
      <FeedbackLine feedback={feedback} className="" />
      {importing ? (
        <ImportFromGitHubDialog orgId={orgId} onOpenProject={openProjectChat} onClose={() => setImporting(false)} />
      ) : null}
      {disconnecting ? (
        <ConfirmationDialog
          dialogTitle={`Disconnect ${disconnecting.accountLogin}?`}
          dialogBody={`Projects already imported stay as they are. Private repositories from github.com/${disconnecting.accountLogin} can't be imported until it's connected again.`}
          confirmText="Disconnect"
          onClose={() => setDisconnecting(null)}
          onConfirm={() => disconnect(disconnecting.installationId)}
        />
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
  const source = projectSource(project);
  return (
    <li className="min-w-0 px-3 py-2">
      <details className="group min-w-0">
        <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1 basis-40">
            <span className="block truncate text-content-primary">{project.name}</span>
            {source ? <span className="block truncate text-xs text-content-tertiary">{source}</span> : null}
          </span>
          <span className="text-xs text-content-secondary">
            {project.access.length === 0
              ? 'Admins only'
              : `${project.access.length} ${project.access.length === 1 ? 'member' : 'members'}`}
          </span>
          <ChevronDownIcon aria-hidden className="text-content-tertiary transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-3 grid min-w-0 gap-3 border-t border-bolt-elements-borderColor pt-3">
          <ProjectAccessList
            orgId={orgId}
            project={project}
            members={members}
            access={project.access}
            onChanged={onChanged}
            onError={onError}
          />
          {project.origin === 'promoted' ? <WorkersBuildsInstruction /> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {confirmingRemove ? (
              <>
                <span className="mr-auto text-xs text-content-secondary">
                  Its site and code stay in the Cloudflare account.
                </span>
                <Button size="xs" variant="subtle" onClick={() => setConfirmingRemove(false)}>
                  Cancel
                </Button>
                <Button size="xs" variant="danger" aria-label={`Remove from team: ${project.name}`} onClick={remove}>
                  Remove from team
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="subtle"
                className="!text-content-error"
                aria-label={`Remove ${project.name}`}
                onClick={() => setConfirmingRemove(true)}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      </details>
    </li>
  );
}

/** Where a project's code came from, while that still matters: an import not yet made. */
function projectSource(project: OrgProject): string | null {
  return project.importRepoFullName && project.repo === null
    ? `imports from github.com/${project.importRepoFullName} when first opened`
    : null;
}

/** How an admin has Workers Builds deploy a project approved from a draft: the dashboard does it, once. */
function WorkersBuildsInstruction() {
  return (
    <p className="text-xs text-content-secondary">
      To put it live, connect it in{' '}
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
        noteFeedback(
          `Approved ${pending.title}. It's a team project now. To put it live, connect it in Workers Builds.`,
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
    <li className="grid min-w-0 gap-1.5 rounded-md border border-accent-500/40 bg-bolt-elements-background-depth-2 p-3 [overflow-wrap:anywhere]">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusBadge tone="warning">Team project request</StatusBadge>
        <strong className="min-w-0">{pending.title}</strong>
        <span className="text-xs text-content-tertiary">
          from {pending.requesterName || pending.requesterEmail}
          {pending.updatedAt ? ` · updated ${timeAgo(pending.updatedAt)}` : ''}
        </span>
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
            variant="neutral"
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
        <ul className="mt-2 grid gap-1.5 text-sm [overflow-wrap:anywhere]" aria-label="Your team project requests">
          {requests.map((request) => (
            <li key={request.id} className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0">{request.title}</span>
              {request.status === 'pending' ? (
                <StatusBadge tone="warning">Waiting for an admin</StatusBadge>
              ) : request.status === 'approved' ? (
                <StatusBadge tone="success">Approved, now a project</StatusBadge>
              ) : (
                <>
                  <StatusBadge tone="error">Declined</StatusBadge>
                  {request.decisionNote ? (
                    <span className="text-xs text-content-tertiary">{request.decisionNote}</span>
                  ) : null}
                </>
              )}
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
