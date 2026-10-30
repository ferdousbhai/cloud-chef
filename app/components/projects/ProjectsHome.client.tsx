import { useStore } from '@nanostores/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  CodeIcon,
  CopyIcon,
  CounterClockwiseClockIcon,
  DownloadIcon,
  GitHubLogoIcon,
  LockClosedIcon,
  LockOpen1Icon,
  Pencil1Icon,
  PersonIcon,
  PlusIcon,
  TrashIcon,
  UploadIcon,
} from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { ConfirmationDialog } from '@ui/ConfirmationDialog';
import { Menu, MenuItem } from '@ui/Menu';
import { workspacePreparingMessage } from '~/components/WorkspacePreparing';
import { authClient } from '~/lib/auth-client';
import {
  deleteProject,
  loadDeletionPreview,
  loadTeamProjects,
  openTeamProject,
  setProjectVisibility,
  type ProjectVisibility,
  type TeamProject,
} from '~/lib/cloudflare/org-projects.client';
import {
  downloadProjectArchive,
  openProjectWorkspace,
  retryProjectDeploy,
  type ProjectRef,
} from '~/lib/cloudflare/projects.client';
import {
  cloudflareReauthorizationRequiredStore,
  userWorkspacePreparingStore,
  userWorkspaceUpgradingStore,
} from '~/lib/cloudflare/runtime-session';
import { CloudflareReauthorizePrompt, noteCloudflareReauthorization } from '~/components/CloudflareReauthorizePrompt';
import { isImportReturn, IMPORT_RETURN_PARAM } from '~/lib/github-app.client';
import { messageOf } from '~/lib/json-request';
import { CloneDialog } from './CloneDialog.client';
import { CopyProjectDialog } from './CopyProjectDialog.client';
import { DeleteProjectDialog } from './DeleteProjectDialog.client';
import { DeployLogDialog } from './DeployLogDialog.client';
import { ImportFromGitHubDialog } from './ImportFromGitHubDialog.client';
import { deployInProgress, ProjectCard, ProjectCardSkeletons, type CardDeploy } from './ProjectCard';
import { archiveName, ProjectHistoryDialog } from './ProjectHistoryDialog.client';
import { ShareProjectDialog } from './ShareProjectDialog.client';
import { UploadZipDialog } from './UploadZipDialog.client';

type OpenDialog =
  | { kind: 'history'; project: ProjectRef; name: string; canRevert: boolean }
  | { kind: 'clone'; project: ProjectRef; name: string; fullName: string | null }
  | { kind: 'share'; orgId: string; project: { id: string; name: string } }
  | { kind: 'import' }
  | { kind: 'upload' }
  | { kind: 'copy'; project: { id: string; name: string } }
  | { kind: 'make-public'; name: string; makePublic: () => void }
  | { kind: 'delete'; project: TeamProject; connection: ConnectionProjects }
  | { kind: 'deploy-log'; orgProjectId: string; deploymentId: string; name: string; live?: boolean }
  | {
      kind: 'use-wanted-worker';
      project: TeamProject;
      deploymentId: string;
      workerName: string;
      connection: ConnectionProjects;
    };

/**
 * The signed-in home's projects, below the prompt that starts a new one: the projects of the account the person is
 * working in, their own outside a team, and in a team the team projects they may view or edit.
 */
export function ProjectsHome() {
  const { data: session } = authClient.useSession();
  const context = session?.context ?? null;
  const team = context?.kind === 'organization' ? context : null;
  // In a team only its admins import, since a team's projects are theirs to add.
  const canImport = team === null || team.role === 'admin';
  // Back from installing the GitHub App: the import dialog opens again, and the address forgets the visit.
  const [dialog, setDialog] = useState<OpenDialog | null>(() =>
    isImportReturn(window.location.search) ? { kind: 'import' } : null,
  );
  useEffect(() => {
    if (isImportReturn(window.location.search)) {
      const url = new URL(window.location.href);
      url.searchParams.delete(IMPORT_RETURN_PARAM);
      // A connection made: the dialog shows it in its list, so the return's note isn't kept in the address.
      url.searchParams.delete('github_message');
      window.history.replaceState(window.history.state, '', url);
    }
  }, []);

  // Permissions to approve again block every list here: the first section says so once, and the rest stay quiet.
  const reauthorize = useStore(cloudflareReauthorizationRequiredStore);

  // Beside the first section's heading: the team's in a team, the person's own otherwise.
  const addProject = canImport ? <AddProjectMenu onDialog={setDialog} /> : null;

  return (
    <div className="mx-auto mt-8 grid w-full max-w-6xl gap-10 pb-10">
      {team ? (
        <TeamProjects
          orgId={team.orgId}
          admin={team.role === 'admin'}
          heading={team.role === 'admin' ? 'Team projects' : 'Shared with me'}
          action={addProject}
          reauthorization={reauthorize ? 'prompt' : null}
          onDialog={setDialog}
        />
      ) : (
        <OwnProjects action={addProject} reauthorization={reauthorize ? 'prompt' : null} onDialog={setDialog} />
      )}
      {dialog?.kind === 'history' ? (
        <ProjectHistoryDialog
          project={dialog.project}
          name={dialog.name}
          canRevert={dialog.canRevert}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'clone' ? (
        <CloneDialog
          project={dialog.project}
          name={dialog.name}
          fullName={dialog.fullName}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'share' ? (
        <ShareProjectDialog orgId={dialog.orgId} project={dialog.project} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'import' ? (
        <ImportFromGitHubDialog
          orgId={team?.orgId ?? null}
          onOpenProject={openProjectWorkspace}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'deploy-log' ? (
        <DeployLogDialog
          orgProjectId={dialog.orgProjectId}
          deploymentId={dialog.deploymentId}
          name={dialog.name}
          live={dialog.live}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'use-wanted-worker' ? (
        <ConfirmationDialog
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void dialog.connection.retry(dialog.project, dialog.deploymentId, { toWantedWorker: true });
          }}
          confirmText="Replace it"
          dialogTitle={`Publish ${dialog.project.name} to ${dialog.workerName}?`}
          dialogBody={
            <p>
              {`Whatever the Worker named ${dialog.workerName} runs now is replaced with this project, and the project publishes there from then on. The copy it published under the other name stays in your Cloudflare account until you delete it there.`}
            </p>
          }
        />
      ) : null}
      {dialog?.kind === 'copy' ? (
        <CopyProjectDialog
          project={dialog.project}
          onOpenProject={openProjectWorkspace}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'make-public' ? (
        <ConfirmationDialog
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            dialog.makePublic();
          }}
          confirmText="Make public"
          dialogTitle={`Make ${dialog.name} public?`}
          dialogBody={
            <p>
              Anyone signed in to CloudChef will be able to find it in Explore, open its site, read its code and make
              their own copy. Only people you’ve given access can change it.
            </p>
          }
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteProjectDialog
          name={dialog.project.name}
          preview={() => loadDeletionPreview(dialog.project.id)}
          onDelete={() => deleteProject(dialog.project.id, dialog.project.name)}
          onDeleted={() => {
            dialog.connection.forget(dialog.project);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'upload' ? (
        <UploadZipDialog onOpenProject={openProjectWorkspace} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

/** Whether Cloudflare must be reauthorized before the list loads, which the section then says. */
type Reauthorization = 'prompt' | null;

/** One quiet control for bringing in code made elsewhere: from GitHub, or a ZIP. */
function AddProjectMenu({ onDialog }: { onDialog: (dialog: OpenDialog) => void }) {
  return (
    <Menu
      buttonProps={{
        variant: 'neutral',
        size: 'xs',
        title: 'Add an existing project',
        icon: <PlusIcon />,
        children: 'Add an existing project',
      }}
    >
      <MenuItem action={() => onDialog({ kind: 'import' })}>
        <GitHubLogoIcon />
        Import from GitHub
      </MenuItem>
      <MenuItem action={() => onDialog({ kind: 'upload' })}>
        <UploadIcon />
        Upload a ZIP
      </MenuItem>
    </Menu>
  );
}

/** How often the team's projects are asked for again while one of them is being published. */
export const PUBLISHING_REFRESH_MS = 5_000;

function download(project: ProjectRef, name: string) {
  downloadProjectArchive(project, archiveName(name)).catch((error) =>
    toast.error(messageOf(error, 'The ZIP could not be downloaded. Try again.')),
  );
}

function OwnProjects({
  action,
  reauthorization,
  onDialog,
}: {
  action: ReactNode;
  /** Whether Cloudflare must be reauthorized first. */
  reauthorization: Reauthorization;
  onDialog: (dialog: OpenDialog) => void;
}) {
  const workspacePreparing = useStore(userWorkspacePreparingStore);
  const workspaceUpgrading = useStore(userWorkspaceUpgradingStore);
  const added = useConnectionProjects(onDialog);
  const projects = [...(added.projects ?? [])].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const blocked = reauthorization !== null;
  const failed = !blocked && added.loadFailed;

  return (
    <section aria-labelledby="my-projects" className="grid gap-4">
      <SectionHeading id="my-projects" action={action}>
        My projects
      </SectionHeading>
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-content-secondary">
          <span>Projects could not be loaded.</span>
          <Button size="xs" variant="neutral" onClick={added.reload}>
            Try again
          </Button>
        </div>
      ) : null}
      {reauthorization === 'prompt' ? <CloudflareReauthorizePrompt /> : null}
      {blocked || failed ? null : added.projects === null ? (
        <>
          <p className="text-sm text-content-tertiary" role="status">
            {workspacePreparing ? workspacePreparingMessage(workspaceUpgrading) : 'Loading projects…'}
          </p>
          <ProjectCardSkeletons />
        </>
      ) : projects.length === 0 ? (
        <p className="text-sm text-content-secondary">No projects yet. Describe an app above to start one.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ConnectionProjectCard
              key={project.id}
              project={project}
              canEdit={project.role === 'edit'}
              ownsAccount
              badge={null}
              orgId={null}
              connection={added}
              onDialog={onDialog}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A card's menu items for making the project public or private, for someone who may decide that, and for
 * making a copy of it. Making it public asks first.
 */
function PublicAndCopyItems({
  project,
  visibility,
  onChangeVisibility,
  onDialog,
}: {
  project: { id: string; name: string };
  visibility: ProjectVisibility;
  /** Left out for someone who may not make it public or private. */
  onChangeVisibility?: (visibility: ProjectVisibility) => void;
  onDialog: (dialog: OpenDialog) => void;
}) {
  return (
    <>
      {onChangeVisibility ? (
        visibility === 'public' ? (
          <MenuItem action={() => onChangeVisibility('private')}>
            <LockClosedIcon />
            Make private
          </MenuItem>
        ) : (
          <MenuItem
            action={() =>
              onDialog({ kind: 'make-public', name: project.name, makePublic: () => onChangeVisibility('public') })
            }
          >
            <LockOpen1Icon />
            Make public
          </MenuItem>
        )
      ) : null}
      <MenuItem action={() => onDialog({ kind: 'copy', project })}>
        <CopyIcon />
        Make a copy
      </MenuItem>
    </>
  );
}

/** Makes a project public or private, and says how that went. Returns the visibility it has now, or null. */
async function changeVisibilityOf(
  project: { id: string; name: string },
  visibility: ProjectVisibility,
): Promise<ProjectVisibility | null> {
  try {
    const changed = await setProjectVisibility(project.id, visibility);
    toast.success(changed === 'public' ? `${project.name} is public.` : `${project.name} is private again.`);
    return changed;
  } catch (error) {
    toast.error(
      messageOf(error, `${project.name} could not be made ${visibility === 'public' ? 'public' : 'private'}.`),
    );
    return null;
  }
}

/** The projects of the account the person works in, kept fresh while one is being published. */
type ConnectionProjects = {
  projects: TeamProject[] | null;
  loadFailed: boolean;
  reload: () => void;
  opening: string | null;
  /** Why opening a project last failed, beside its Edit button. */
  openFailure: { id: string; message: string } | null;
  open: (project: TeamProject) => Promise<void>;
  retrying: string | null;
  retry: (project: TeamProject, deploymentId: string, options?: { toWantedWorker?: true }) => Promise<void>;
  changeVisibility: (project: TeamProject, visibility: ProjectVisibility) => Promise<void>;
  /** Takes a project deleted for good off the list. */
  forget: (project: TeamProject) => void;
};

function useConnectionProjects(
  onDialog: (dialog: OpenDialog) => void,
  orgId: string | null = null,
): ConnectionProjects {
  const [projects, setProjects] = useState<TeamProject[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailure, setOpenFailure] = useState<{ id: string; message: string } | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  // The list the last refresh showed, so a publish that ends since is announced once.
  const shown = useRef<TeamProject[] | null>(null);
  useEffect(() => {
    shown.current = projects;
  }, [projects]);

  useEffect(() => {
    const controller = new AbortController();
    loadTeamProjects(controller.signal)
      .then((listed) => {
        setProjects(listed);
        setLoadFailed(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          noteCloudflareReauthorization(error);
          setLoadFailed(true);
        }
      });
    return () => controller.abort();
  }, [orgId, attempt]);

  // While any project is being published, the list is asked for again until none is.
  const publishing = projects?.some((project) => isCloudChef(project) && deployInProgress(project.deployment?.state));
  useEffect(() => {
    if (!publishing) {
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      loadTeamProjects(controller.signal)
        .then((next) => {
          announceFinishedPublishes(shown.current ?? [], next, onDialog);
          setProjects(next);
        })
        .catch(() => {
          // A missed refresh is tried again on the next round.
          if (!controller.signal.aborted) {
            setRefresh((count) => count + 1);
          }
        });
    }, PUBLISHING_REFRESH_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [publishing, projects, refresh, onDialog]);

  const retry = async (project: TeamProject, deploymentId: string, options: { toWantedWorker?: true } = {}) => {
    setRetrying(project.id);
    try {
      const id = await retryProjectDeploy(project.id, deploymentId, options);
      // Shown as publishing at once; the refresh while it is brings its progress.
      setProjects(
        (current) =>
          current?.map((listed) =>
            listed.id === project.id
              ? {
                  ...listed,
                  deployment: { id, state: 'queued', failureStage: null, reason: null, updatedAt: Date.now() },
                }
              : listed,
          ) ?? null,
      );
    } catch (error) {
      toast.error(messageOf(error, `${project.name} could not be published again. Try again.`));
    } finally {
      setRetrying(null);
    }
  };

  const changeVisibility = async (project: TeamProject, visibility: ProjectVisibility) => {
    const changed = await changeVisibilityOf(project, visibility);
    if (changed) {
      setProjects(
        (current) =>
          current?.map((listed) => (listed.id === project.id ? { ...listed, visibility: changed } : listed)) ?? null,
      );
    }
  };

  const forget = (project: TeamProject) =>
    setProjects((current) => current?.filter((listed) => listed.id !== project.id) ?? null);

  const open = async (project: TeamProject) => {
    setOpening(project.id);
    setOpenFailure(null);
    try {
      if (!(await openTeamProject(project))) {
        setOpening(null);
      }
    } catch (error) {
      // Permissions to approve again show as the page's one prompt; anything else is said beside Edit.
      if (!(error instanceof Error && noteCloudflareReauthorization(error))) {
        setOpenFailure({
          id: project.id,
          message: messageOf(error, `${project.name} could not be opened. Try again.`),
        });
      }
      setOpening(null);
    }
  };

  return {
    projects,
    loadFailed,
    reload: () => {
      setLoadFailed(false);
      setAttempt((count) => count + 1);
    },
    opening,
    openFailure,
    open,
    retrying,
    retry,
    changeVisibility,
    forget,
  };
}

function ConnectionProjectCard({
  project,
  canEdit,
  ownsAccount,
  badge,
  orgId,
  connection,
  onDialog,
}: {
  project: TeamProject;
  canEdit: boolean;
  /** Whether the person owns the account (theirs, or a team they administer): only they publish over its Workers. */
  ownsAccount: boolean;
  badge: string | null;
  /** The team whose project it is, for sharing; null for a project of the person's own account. */
  orgId: string | null;
  connection: ConnectionProjects;
  onDialog: (dialog: OpenDialog) => void;
}) {
  const ref = { orgProjectId: project.id };
  const deployment = project.deployment ?? null;
  const wantedWorker = deployment?.state === 'succeeded' ? deployment.wantedWorkerName : null;
  const deploy: CardDeploy | undefined = !isCloudChef(project)
    ? undefined
    : deployment && wantedWorker && wantedWorker !== deployment.workerName
      ? {
          state: deployment.state,
          reason: deployment.reason ?? null,
          retrying: connection.retrying === project.id,
          onUseWantedWorker: ownsAccount
            ? () =>
                onDialog({
                  kind: 'use-wanted-worker',
                  project,
                  deploymentId: deployment.id,
                  workerName: wantedWorker,
                  connection,
                })
            : undefined,
        }
      : deployment?.state !== 'failed'
        ? {
            state: deployment?.state ?? null,
            reason: deployment?.reason ?? null,
            step: deployment?.step ?? null,
            stepStartedAt: deployment?.stepStartedAt ?? null,
            onShowProgress: deployment
              ? () =>
                  onDialog({
                    kind: 'deploy-log',
                    orgProjectId: project.id,
                    deploymentId: deployment.id,
                    name: project.name,
                    live: true,
                  })
              : undefined,
          }
        : {
            state: deployment.state,
            reason: deployment.reason ?? null,
            onRetry: canEdit ? () => void connection.retry(project, deployment.id) : undefined,
            retrying: connection.retrying === project.id,
            onShowLog: () =>
              onDialog({
                kind: 'deploy-log',
                orgProjectId: project.id,
                deploymentId: deployment.id,
                name: project.name,
              }),
          };
  return (
    <ProjectCard
      title={project.name}
      updatedAt={project.lastChange?.at ?? project.createdAt ?? null}
      updatedBy={project.lastChange?.by ?? null}
      siteUrl={project.siteUrl ?? null}
      siteFramed={project.siteFrameable !== false}
      subtitle={project.fullName}
      isPublic={project.visibility === 'public'}
      badge={badge ?? undefined}
      deploy={deploy}
      note={connection.openFailure?.id === project.id ? connection.openFailure.message : null}
      primary={
        canEdit ? (
          <Button
            size="xs"
            icon={<Pencil1Icon />}
            aria-label={`Edit ${project.name}`}
            disabled={connection.opening !== null}
            loading={connection.opening === project.id}
            onClick={() => void connection.open(project)}
          >
            Edit
          </Button>
        ) : null
      }
      menuItems={
        <>
          <MenuItem action={() => onDialog({ kind: 'history', project: ref, name: project.name, canRevert: canEdit })}>
            <CounterClockwiseClockIcon />
            History
          </MenuItem>
          {/* Cloning reads it through CloudChef's git address, as Download ZIP does: viewing is enough. */}
          <MenuItem
            action={() =>
              onDialog({ kind: 'clone', project: ref, name: project.name, fullName: project.fullName ?? null })
            }
          >
            <CodeIcon />
            Clone
          </MenuItem>
          <MenuItem action={() => download(ref, project.name)}>
            <DownloadIcon />
            Download ZIP
          </MenuItem>
          {orgId ? (
            <MenuItem
              action={() => onDialog({ kind: 'share', orgId, project: { id: project.id, name: project.name } })}
            >
              <PersonIcon />
              Share
            </MenuItem>
          ) : null}
          <PublicAndCopyItems
            project={{ id: project.id, name: project.name }}
            visibility={project.visibility ?? 'private'}
            onChangeVisibility={
              project.canManage ? (visibility) => void connection.changeVisibility(project, visibility) : undefined
            }
            onDialog={onDialog}
          />
          {project.canManage ? (
            <MenuItem danger action={() => onDialog({ kind: 'delete', project, connection })}>
              <TrashIcon />
              Delete
            </MenuItem>
          ) : null}
        </>
      }
    />
  );
}

function TeamProjects({
  orgId,
  admin,
  heading,
  action,
  reauthorization,
  onDialog,
}: {
  orgId: string;
  admin: boolean;
  heading: string;
  action: ReactNode;
  reauthorization: Reauthorization;
  onDialog: (dialog: OpenDialog) => void;
}) {
  const connection = useConnectionProjects(onDialog, orgId);
  const { projects } = connection;

  return (
    <section aria-labelledby="team-projects" className="grid gap-4">
      <SectionHeading id="team-projects" action={action}>
        {heading}
      </SectionHeading>
      {reauthorization === 'prompt' ? <CloudflareReauthorizePrompt /> : null}
      {connection.loadFailed && reauthorization !== null ? null : connection.loadFailed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-content-secondary">
          <span>{heading} could not be loaded.</span>
          <Button size="xs" variant="neutral" onClick={connection.reload}>
            Try again
          </Button>
        </div>
      ) : projects === null ? (
        <>
          <p className="text-sm text-content-tertiary" role="status">
            Loading team projects…
          </p>
          <ProjectCardSkeletons />
        </>
      ) : projects.length === 0 ? (
        <p className="text-sm text-content-secondary">
          {admin ? 'No team projects yet.' : 'No team projects are shared with you yet.'}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            // Admins own every team project, so they can always edit it.
            const canEdit = admin || project.role === 'edit';
            return (
              <ConnectionProjectCard
                key={project.id}
                project={project}
                canEdit={canEdit}
                ownsAccount={admin}
                badge={admin ? 'Owner' : canEdit ? 'Can edit' : 'Can view'}
                orgId={admin ? orgId : null}
                connection={connection}
                onDialog={onDialog}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Says once when a publish that was running has ended, wherever on the page the person is looking: live, with
 * its site to open, or not, with what happened.
 */
function announceFinishedPublishes(
  before: readonly TeamProject[],
  after: readonly TeamProject[],
  onDialog: (dialog: OpenDialog) => void,
): void {
  for (const project of after) {
    const was = before.find(({ id }) => id === project.id)?.deployment;
    const now = project.deployment;
    if (!was || !now || was.id !== now.id || !deployInProgress(was.state) || deployInProgress(now.state)) {
      continue;
    }
    const siteUrl = project.siteUrl;
    if (now.state === 'succeeded') {
      toast.success(`${project.name} is live.`, {
        action: siteUrl ? { label: 'Open site', onClick: () => window.open(siteUrl, '_blank', 'noopener') } : undefined,
      });
    } else if (now.state === 'failed') {
      toast.error(`${project.name} didn’t publish.`, {
        action: {
          label: 'Show what happened',
          onClick: () =>
            onDialog({ kind: 'deploy-log', orgProjectId: project.id, deploymentId: now.id, name: project.name }),
        },
      });
    }
  }
}

/** A project CloudChef builds and publishes itself, rather than Workers Builds. */
function isCloudChef(project: TeamProject): boolean {
  return project.deploysWith === 'cloudchef';
}

function SectionHeading({ id, action, children }: { id: string; action: ReactNode; children: string }) {
  return (
    <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
      <h2 id={id} className="text-sm font-semibold text-content-primary">
        {children}
      </h2>
      {action}
    </div>
  );
}
