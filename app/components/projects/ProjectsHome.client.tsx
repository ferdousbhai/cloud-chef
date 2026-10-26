import { useStore } from '@nanostores/react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  CodeIcon,
  CounterClockwiseClockIcon,
  DownloadIcon,
  GitHubLogoIcon,
  Pencil1Icon,
  PersonIcon,
  PlusIcon,
  UploadIcon,
} from '@radix-ui/react-icons';
import { Button, buttonClassNames } from '@ui/Button';
import { Menu, MenuItem } from '@ui/Menu';
import { Link } from '@tanstack/react-router';
import { workspacePreparingMessage } from '~/components/WorkspacePreparing';
import { authClient } from '~/lib/auth-client';
import { useChatHistory } from '~/lib/cloudflare/chat-history-db';
import type { ChatHistorySummary } from '~/lib/cloudflare/data-api';
import { loadTeamProjects, openTeamProject, type TeamProject } from '~/lib/cloudflare/org-projects.client';
import {
  downloadProjectArchive,
  openProjectChat,
  retryProjectDeploy,
  type ProjectRef,
} from '~/lib/cloudflare/projects.client';
import { userWorkspacePreparingStore, userWorkspaceUpgradingStore } from '~/lib/cloudflare/runtime-session';
import { isImportReturn, IMPORT_RETURN_PARAM } from '~/lib/github-app.client';
import { messageOf } from '~/lib/json-request';
import { CloneDialog } from './CloneDialog.client';
import { DeployLogDialog } from './DeployLogDialog.client';
import { ImportFromGitHubDialog } from './ImportFromGitHubDialog.client';
import { deployInProgress, ProjectCard, type CardDeploy } from './ProjectCard';
import { archiveName, ProjectHistoryDialog } from './ProjectHistoryDialog.client';
import { ShareProjectDialog } from './ShareProjectDialog.client';
import { UploadZipDialog } from './UploadZipDialog.client';

type OpenDialog =
  | { kind: 'history'; project: ProjectRef; name: string; canRevert: boolean; canFork: boolean }
  | { kind: 'clone'; project: ProjectRef; name: string }
  | { kind: 'share'; orgId: string; project: { id: string; name: string } }
  | { kind: 'import' }
  | { kind: 'upload' }
  | { kind: 'deploy-log'; orgProjectId: string; deploymentId: string; name: string };

/**
 * The signed-in home's projects, below the prompt that starts a new one: the person's own projects in the
 * account they're working in, and in a team, the team projects they may view or edit. In a team its projects
 * come first, and the person's own appear only once there are some.
 */
export function ProjectsHome({ userId }: { userId: string }) {
  const { data: session } = authClient.useSession();
  const context = session?.context ?? null;
  const team = context?.kind === 'organization' ? context : null;
  // A member limited to the team's projects can't start or import projects of their own.
  const draftsAllowed = team === null || team.draftsAllowed;
  // In a team only its admins import, since a team's projects are theirs to add.
  const canImport = team === null || team.role === 'admin';
  const [dialog, setDialog] = useState<OpenDialog | null>(null);

  // Back from installing the GitHub App: the import dialog opens again, and the address forgets the visit.
  useEffect(() => {
    if (isImportReturn(window.location.search)) {
      setDialog({ kind: 'import' });
      const url = new URL(window.location.href);
      url.searchParams.delete(IMPORT_RETURN_PARAM);
      // A connection made: the dialog shows it in its list, so the return's note isn't kept in the address.
      url.searchParams.delete('github_message');
      window.history.replaceState(window.history.state, '', url);
    }
  }, []);

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
          onDialog={setDialog}
        />
      ) : null}
      {draftsAllowed ? (
        <OwnProjects
          userId={userId}
          hideWhenEmpty={team !== null}
          action={team ? null : addProject}
          onDialog={setDialog}
        />
      ) : null}
      {dialog?.kind === 'history' ? (
        <ProjectHistoryDialog
          project={dialog.project}
          name={dialog.name}
          canRevert={dialog.canRevert}
          canFork={dialog.canFork}
          onOpenProject={openProjectChat}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'clone' ? (
        <CloneDialog project={dialog.project} name={dialog.name} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'share' ? (
        <ShareProjectDialog orgId={dialog.orgId} project={dialog.project} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'import' ? (
        <ImportFromGitHubDialog
          orgId={team?.orgId ?? null}
          onOpenProject={openProjectChat}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'deploy-log' ? (
        <DeployLogDialog
          orgProjectId={dialog.orgProjectId}
          deploymentId={dialog.deploymentId}
          name={dialog.name}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'upload' ? (
        <UploadZipDialog onOpenProject={openProjectChat} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

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
  userId,
  hideWhenEmpty,
  action,
  onDialog,
}: {
  userId: string;
  /** In a team, where its projects come first, the person's own show only once they have some. */
  hideWhenEmpty: boolean;
  action: ReactNode;
  onDialog: (dialog: OpenDialog) => void;
}) {
  const history = useChatHistory(userId);
  const workspacePreparing = useStore(userWorkspacePreparingStore);
  const workspaceUpgrading = useStore(userWorkspaceUpgradingStore);
  const projects = history.projects;

  if (hideWhenEmpty && projects.length === 0 && history.error == null) {
    return null;
  }

  return (
    <section aria-labelledby="my-projects" className="grid gap-4">
      <SectionHeading id="my-projects" action={action}>
        My projects
      </SectionHeading>
      {history.error != null ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-content-secondary">
          <span>Projects could not be loaded.</span>
          <Button size="xs" variant="neutral" onClick={history.retry}>
            Try again
          </Button>
        </div>
      ) : null}
      {history.isLoading && projects.length === 0 ? (
        <p className="text-sm text-content-tertiary" role="status">
          {workspacePreparing ? workspacePreparingMessage(workspaceUpgrading) : 'Loading projects…'}
        </p>
      ) : !history.isLoading && history.error == null && projects.length === 0 ? (
        <p className="text-sm text-content-secondary">No projects yet. Describe an app above to start one.</p>
      ) : null}
      {projects.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...projects]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .map((project) => (
              <OwnProjectCard key={project.initialId} project={project} onDialog={onDialog} />
            ))}
        </ul>
      ) : null}
    </section>
  );
}

function OwnProjectCard({
  project,
  onDialog,
}: {
  project: ChatHistorySummary;
  onDialog: (dialog: OpenDialog) => void;
}) {
  const name = project.description?.trim() || 'Untitled project';
  const ref = { chatInitialId: project.initialId };
  return (
    <ProjectCard
      title={name}
      updatedAt={project.timestamp}
      siteUrl={project.productionUrl ?? null}
      primary={
        <Link
          to="/chat/$id"
          params={{ id: project.initialId }}
          className={buttonClassNames({ size: 'xs' })}
          aria-label={`Edit ${name}`}
        >
          <Pencil1Icon />
          Edit
        </Link>
      }
      menuItems={
        <>
          <MenuItem action={() => onDialog({ kind: 'history', project: ref, name, canRevert: true, canFork: true })}>
            <CounterClockwiseClockIcon />
            History
          </MenuItem>
          <MenuItem action={() => onDialog({ kind: 'clone', project: ref, name })}>
            <CodeIcon />
            Clone
          </MenuItem>
          <MenuItem action={() => download(ref, name)}>
            <DownloadIcon />
            Download ZIP
          </MenuItem>
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
  onDialog,
}: {
  orgId: string;
  admin: boolean;
  heading: string;
  action: ReactNode;
  onDialog: (dialog: OpenDialog) => void;
}) {
  const [projects, setProjects] = useState<TeamProject[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    loadTeamProjects(controller.signal)
      .then(setProjects)
      .catch(() => {
        if (!controller.signal.aborted) {
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
        .then(setProjects)
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
  }, [publishing, projects, refresh]);

  const retry = async (project: TeamProject, deploymentId: string) => {
    setRetrying(project.id);
    try {
      const id = await retryProjectDeploy(project.id, deploymentId);
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

  const deployOf = (project: TeamProject, canEdit: boolean): CardDeploy | undefined => {
    if (!isCloudChef(project)) {
      return undefined;
    }
    const deployment = project.deployment ?? null;
    if (deployment?.state !== 'failed') {
      return { state: deployment?.state ?? null, reason: deployment?.reason ?? null };
    }
    return {
      state: deployment.state,
      reason: deployment.reason ?? null,
      onRetry: canEdit ? () => void retry(project, deployment.id) : undefined,
      retrying: retrying === project.id,
      onShowLog: () =>
        onDialog({ kind: 'deploy-log', orgProjectId: project.id, deploymentId: deployment.id, name: project.name }),
    };
  };

  const open = async (project: TeamProject) => {
    setOpening(project.id);
    try {
      if (!(await openTeamProject(project))) {
        setOpening(null);
      }
    } catch {
      toast.error(`${project.name} could not be opened. Try again.`);
      setOpening(null);
    }
  };

  return (
    <section aria-labelledby="team-projects" className="grid gap-4">
      <SectionHeading id="team-projects" action={action}>
        {heading}
      </SectionHeading>
      {loadFailed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-content-secondary">
          <span>{heading} could not be loaded.</span>
          <Button size="xs" variant="neutral" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </Button>
        </div>
      ) : projects === null ? (
        <p className="text-sm text-content-tertiary" role="status">
          Loading team projects…
        </p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-content-secondary">
          {admin ? 'No team projects yet.' : 'No team projects are shared with you yet.'}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const ref = { orgProjectId: project.id };
            // Admins own every team project, so they can always edit it.
            const canEdit = admin || project.role === 'edit';
            return (
              <ProjectCard
                key={project.id}
                title={project.name}
                updatedAt={project.lastCommitAt ?? null}
                siteUrl={project.siteUrl ?? null}
                siteFramed={project.siteFrameable !== false}
                badge={admin ? 'Owner' : canEdit ? 'Can edit' : 'Can view'}
                deploy={deployOf(project, canEdit)}
                primary={
                  canEdit ? (
                    <Button
                      size="xs"
                      icon={<Pencil1Icon />}
                      aria-label={`Edit ${project.name}`}
                      disabled={opening !== null}
                      loading={opening === project.id}
                      onClick={() => void open(project)}
                    >
                      Edit
                    </Button>
                  ) : null
                }
                menuItems={
                  <>
                    <MenuItem
                      action={() =>
                        onDialog({
                          kind: 'history',
                          project: ref,
                          name: project.name,
                          canRevert: canEdit,
                          canFork: false,
                        })
                      }
                    >
                      <CounterClockwiseClockIcon />
                      History
                    </MenuItem>
                    {canEdit ? (
                      <MenuItem action={() => onDialog({ kind: 'clone', project: ref, name: project.name })}>
                        <CodeIcon />
                        Clone
                      </MenuItem>
                    ) : null}
                    <MenuItem action={() => download(ref, project.name)}>
                      <DownloadIcon />
                      Download ZIP
                    </MenuItem>
                    {admin ? (
                      <MenuItem
                        action={() =>
                          onDialog({ kind: 'share', orgId, project: { id: project.id, name: project.name } })
                        }
                      >
                        <PersonIcon />
                        Share
                      </MenuItem>
                    ) : null}
                  </>
                }
              />
            );
          })}
        </ul>
      )}
    </section>
  );
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
