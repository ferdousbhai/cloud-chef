import { useEffect, useState } from 'react';
import { ChevronDownIcon } from '@radix-ui/react-icons';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { ConfirmationDialog } from '@ui/ConfirmationDialog';
import { MenuItem } from '@ui/Menu';
import { authClient } from '~/lib/auth-client';
import { projectRoleSchema } from '~/lib/cloudflare/org-projects.client';
import { ImportFromGitHubDialog } from '~/components/projects/ImportFromGitHubDialog.client';
import { IMPORT_RETURN_PARAM, isImportReturn } from '~/lib/github-app.client';
import { ProjectAccessList, type ProjectMember } from '~/components/projects/ProjectAccessList.client';
import { openProjectWorkspace } from '~/lib/cloudflare/projects.client';
import { deleteProject, loadDeletionPreview } from '~/lib/cloudflare/org-projects.client';
import { DeleteProjectDialog } from '~/components/projects/DeleteProjectDialog.client';
import { errorFeedback, FeedbackLine, type Feedback } from './Feedback';
import { noContentSchema, postJson, runRequest } from '~/lib/json-request';
import { MoreMenu } from './SettingsLayout';

/** The GitHub accounts CloudChef's App is installed on for the team: imports read from all of them. */
export const orgGitHubSchema = z.array(
  z.object({ installationId: z.number(), accountLogin: z.string(), accountType: z.string() }),
);
export const orgProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The project's Artifacts repository; null until the first person to open it has imported it. */
  repo: z.string().nullable(),
  createdFrom: z.enum(['github', 'zip', 'draft', 'copy', 'push', 'chat']),
  /** Who publishes it: Workers Builds, which an admin connects, or CloudChef itself. */
  deploysWith: z.enum(['workers_builds', 'cloudchef']),
  /** The GitHub repository it was imported from, for an imported project. */
  importRepoFullName: z.string().nullable(),
  access: z.array(z.object({ userId: z.string(), role: projectRoleSchema })),
});
/** Where an admin connects a team project's repository to Workers Builds, which then deploys it. */
const WORKERS_BUILDS_CREATE_URL = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages/create';

type OrgProject = z.infer<typeof orgProjectSchema>;

const installStartedSchema = z.object({ installUrl: z.string() });

/**
 * An admin's view of a team's projects: each one's repository and who may view or edit it, and the GitHub
 * accounts CloudChef's App reads when importing. Members' requests to make a draft a project are on Approvals.
 */
export function OrgProjectsSection({
  orgId,
  github,
  projects,
  members,
  onChanged,
}: {
  orgId: string;
  github: z.infer<typeof orgGitHubSchema>;
  projects: OrgProject[];
  members: ProjectMember[];
  onChanged: () => Promise<void>;
}) {
  const [disconnecting, setDisconnecting] = useState<z.infer<typeof orgGitHubSchema>[number] | null>(null);
  const [importing, setImporting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const onError = (message: string | null) => setFeedback(errorFeedback(message));
  // Importing acts in the account the person is working in now, so it's offered for that team only.
  const { data: session } = authClient.useSession();
  const workingHere = session?.context?.kind === 'organization' && session.context.orgId === orgId;

  // Back from GitHub to the import dialog started here: it opens again, listing what was just connected, once the
  // session says this is the team being worked in.
  const [returnPending, setReturnPending] = useState(() => isImportReturn(window.location.search));
  if (returnPending && workingHere) {
    setReturnPending(false);
    setImporting(true);
  }
  useEffect(() => {
    if (importing && isImportReturn(window.location.search)) {
      const url = new URL(window.location.href);
      url.searchParams.delete(IMPORT_RETURN_PARAM);
      url.searchParams.delete('github_message');
      window.history.replaceState(window.history.state, '', url);
    }
  }, [importing]);

  const connect = () =>
    void runRequest(async () => {
      const { installUrl } = await postJson(
        '/api/organizations/github/start',
        // Back to this Settings page itself, which says what GitHub's return did.
        { orgId, callbackURL: window.location.href },
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
                <MenuItem action={connect}>Add GitHub accounts or repositories</MenuItem>
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
        <p className="text-xs text-content-tertiary">To import a project from GitHub, switch to this team first.</p>
      )}
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
        <ImportFromGitHubDialog
          orgId={orgId}
          onOpenProject={openProjectWorkspace}
          onClose={() => setImporting(false)}
        />
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
  const [deleting, setDeleting] = useState(false);
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
          {project.deploysWith === 'workers_builds' && project.createdFrom !== 'github' ? (
            <WorkersBuildsInstruction />
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="xs"
              variant="subtle"
              className="text-content-error!"
              aria-label={`Delete ${project.name}`}
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          </div>
        </div>
      </details>
      {deleting ? (
        <DeleteProjectDialog
          name={project.name}
          preview={() => loadDeletionPreview(project.id)}
          onDelete={() => deleteProject(project.id, project.name)}
          onDeleted={() => {
            setDeleting(false);
            void onChanged();
          }}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </li>
  );
}

/** Where a project's code came from, while that still matters: an import not yet made. */
function projectSource(project: OrgProject): string | null {
  return project.importRepoFullName && project.repo === null
    ? `imports from github.com/${project.importRepoFullName} when first opened`
    : null;
}

/**
 * How an admin has Workers Builds deploy a project that didn't come from GitHub (an approved draft, or a ZIP
 * upload), so has no Worker building it yet: the dashboard does it, once.
 */
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

/** A member's list of the projects they were given in an organization. */
export function MyOrgProjects({ projects }: { projects: OrgProject[] }) {
  return projects.length > 0 ? (
    <p className="mt-2 text-sm text-content-secondary wrap-anywhere">
      Your projects: {projects.map((project) => project.name).join(', ')}
    </p>
  ) : null;
}
