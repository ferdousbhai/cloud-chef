import { useStore } from '@nanostores/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  CodeIcon,
  CopyIcon,
  CounterClockwiseClockIcon,
  DownloadIcon,
  GitHubLogoIcon,
  GlobeIcon,
  LockClosedIcon,
  LockOpen1Icon,
  Pencil1Icon,
  PersonIcon,
  PlusIcon,
  UploadIcon,
} from '@radix-ui/react-icons';
import { Button, buttonClassNames } from '@ui/Button';
import { ConfirmationDialog } from '@ui/ConfirmationDialog';
import { Menu, MenuItem } from '@ui/Menu';
import { Link } from '@tanstack/react-router';
import { workspacePreparingMessage } from '~/components/WorkspacePreparing';
import { LinkButton } from '~/components/ui/LinkButton';
import { authClient } from '~/lib/auth-client';
import { useWorkspaceHistory } from '~/lib/cloudflare/workspace-history-db';
import type { WorkspaceSummary } from '~/lib/cloudflare/data-api';
import {
  loadApps,
  loadTeamProjects,
  openTeamProject,
  setProjectVisibility,
  type App,
  type ProjectVisibility,
  type TeamProject,
} from '~/lib/cloudflare/org-projects.client';
import {
  downloadProjectArchive,
  openProjectWorkspace,
  retryProjectDeploy,
  type ProjectRef,
} from '~/lib/cloudflare/projects.client';
import { userWorkspacePreparingStore, userWorkspaceUpgradingStore } from '~/lib/cloudflare/runtime-session';
import { isImportReturn, IMPORT_RETURN_PARAM } from '~/lib/github-app.client';
import { messageOf } from '~/lib/json-request';
import { CloneDialog } from './CloneDialog.client';
import { CopyProjectDialog } from './CopyProjectDialog.client';
import { DeployLogDialog } from './DeployLogDialog.client';
import { ImportFromGitHubDialog } from './ImportFromGitHubDialog.client';
import { deployInProgress, ProjectCard, ProjectCardSkeletons, type CardDeploy } from './ProjectCard';
import { archiveName, ProjectHistoryDialog } from './ProjectHistoryDialog.client';
import { ShareProjectDialog } from './ShareProjectDialog.client';
import { UploadZipDialog } from './UploadZipDialog.client';

type OpenDialog =
  | { kind: 'history'; project: ProjectRef; name: string; canRevert: boolean; canFork: boolean }
  | { kind: 'clone'; project: ProjectRef; name: string; fullName: string | null }
  | { kind: 'share'; orgId: string; project: { id: string; name: string } }
  | { kind: 'import' }
  | { kind: 'upload' }
  | { kind: 'copy'; project: { id: string; name: string } }
  | { kind: 'make-public'; name: string; makePublic: () => void }
  | { kind: 'deploy-log'; orgProjectId: string; deploymentId: string; name: string; live?: boolean }
  | {
      kind: 'use-wanted-worker';
      project: TeamProject;
      deploymentId: string;
      workerName: string;
      connection: ConnectionProjects;
    };

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
  const addProject = (
    <div className="flex flex-wrap items-center gap-2">
      <LinkButton variant="subtle" size="xs" to="/explore" icon={<GlobeIcon />}>
        Explore
      </LinkButton>
      {canImport ? <AddProjectMenu onDialog={setDialog} /> : null}
    </div>
  );

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
          onOpenProject={openProjectWorkspace}
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
      {dialog?.kind === 'upload' ? (
        <UploadZipDialog onOpenProject={openProjectWorkspace} onClose={() => setDialog(null)} />
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
  /**
   * In a team, where its projects come first, the person's own show only once they have some. Outside one, the
   * projects added to the person's own account (imported or uploaded) are listed with them.
   */
  hideWhenEmpty: boolean;
  action: ReactNode;
  onDialog: (dialog: OpenDialog) => void;
}) {
  const history = useWorkspaceHistory(userId);
  const workspacePreparing = useStore(userWorkspacePreparingStore);
  const workspaceUpgrading = useStore(userWorkspaceUpgradingStore);
  const added = useConnectionProjects(!hideWhenEmpty, onDialog);
  const chats = history.projects;
  const apps = useApps(chats.map((chat) => chat.initialId).join(' '));
  const addedProjects = added.projects ?? [];
  const empty = chats.length === 0 && addedProjects.length === 0;
  const failed = history.error != null || added.loadFailed;

  if (hideWhenEmpty && chats.length === 0 && history.error == null) {
    return null;
  }

  const cards = [
    ...chats.map((chat) => ({
      key: chat.initialId,
      at: chat.timestamp,
      card: (
        <OwnProjectCard
          key={chat.initialId}
          project={chat}
          app={apps.apps?.get(chat.initialId) ?? null}
          onChangeVisibility={apps.changeVisibility}
          onDialog={onDialog}
        />
      ),
    })),
    ...addedProjects.map((project) => ({
      key: project.id,
      at: project.lastCommitAt ?? '',
      card: (
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
      ),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <section aria-labelledby="my-projects" className="grid gap-4">
      <SectionHeading id="my-projects" action={action}>
        My projects
      </SectionHeading>
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-content-secondary">
          <span>Projects could not be loaded.</span>
          <Button
            size="xs"
            variant="neutral"
            onClick={() => {
              if (history.error != null) {
                history.retry();
              }
              if (added.loadFailed) {
                added.reload();
              }
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {history.isLoading && empty ? (
        <>
          <p className="text-sm text-content-tertiary" role="status">
            {workspacePreparing ? workspacePreparingMessage(workspaceUpgrading) : 'Loading projects…'}
          </p>
          <ProjectCardSkeletons />
        </>
      ) : !history.isLoading && !failed && empty && (hideWhenEmpty || added.projects !== null) ? (
        <p className="text-sm text-content-secondary">No projects yet. Describe an app above to start one.</p>
      ) : null}
      {cards.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{cards.map(({ card }) => card)}</ul>
      ) : null}
    </section>
  );
}

function OwnProjectCard({
  project,
  app,
  onChangeVisibility,
  onDialog,
}: {
  project: WorkspaceSummary;
  /** The app as CloudChef records it; null until it has. */
  app: App | null;
  onChangeVisibility: (app: App, name: string, visibility: ProjectVisibility) => Promise<void>;
  onDialog: (dialog: OpenDialog) => void;
}) {
  const name = project.description?.trim() || 'Untitled project';
  const ref = { chatInitialId: project.initialId };
  return (
    <ProjectCard
      title={name}
      updatedAt={project.timestamp}
      siteUrl={project.productionUrl ?? null}
      subtitle={app?.fullName}
      isPublic={app?.visibility === 'public'}
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
          <MenuItem action={() => onDialog({ kind: 'clone', project: ref, name, fullName: app?.fullName ?? null })}>
            <CodeIcon />
            Clone
          </MenuItem>
          <MenuItem action={() => download(ref, name)}>
            <DownloadIcon />
            Download ZIP
          </MenuItem>
          {app ? (
            <PublicAndCopyItems
              project={{ id: app.id, name }}
              visibility={app.visibility}
              onChangeVisibility={(visibility) => void onChangeVisibility(app, name, visibility)}
              onDialog={onDialog}
            />
          ) : null}
        </>
      }
    />
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

/**
 * The person's apps as CloudChef records them, by id, asked for again when the chat list (`chatIds`) changes,
 * since a new chat is recorded once it is listed. Null until loaded; an app missing from it has no address or
 * visibility yet.
 */
/** How long after the chat list a new app is asked for again, once its record has had time to be made. */
const APPS_RETRY_MS = 4_000;

function useApps(chatIds: string) {
  const connectionId = authClient.useSession().data?.context?.connectionId ?? null;
  const [apps, setApps] = useState<ReadonlyMap<string, App> | null>(null);

  useEffect(() => {
    if (chatIds === '') {
      // No chats, so no apps to show.
      return undefined;
    }
    const controller = new AbortController();
    let retry: number | undefined;
    const load = (again: boolean) =>
      loadApps(controller.signal)
        .then((loaded) => {
          setApps(new Map(loaded.map((app) => [app.id, app])));
          // Listing the chats tells CloudChef about a new app in the background: if one isn't known yet, ask once more.
          const known = new Set(loaded.map((app) => app.id));
          if (again && chatIds.split(' ').some((id) => !known.has(id))) {
            retry = window.setTimeout(() => void load(false), APPS_RETRY_MS);
          }
        })
        .catch(() => {
          // Without them, the cards have no address and no public or copy actions; the next list asks again.
        });
    void load(true);
    return () => {
      controller.abort();
      window.clearTimeout(retry);
    };
  }, [connectionId, chatIds]);

  const changeVisibility = async (app: App, name: string, visibility: ProjectVisibility) => {
    const changed = await changeVisibilityOf({ id: app.id, name }, visibility);
    if (changed) {
      setApps((current) => current && new Map(current).set(app.id, { ...app, visibility: changed }));
    }
  };

  return { apps, changeVisibility };
}

/** The projects of the account the person works in, kept fresh while one is being published. */
type ConnectionProjects = {
  projects: TeamProject[] | null;
  loadFailed: boolean;
  reload: () => void;
  opening: string | null;
  open: (project: TeamProject) => Promise<void>;
  retrying: string | null;
  retry: (project: TeamProject, deploymentId: string, options?: { toWantedWorker?: true }) => Promise<void>;
  changeVisibility: (project: TeamProject, visibility: ProjectVisibility) => Promise<void>;
};

function useConnectionProjects(
  enabled: boolean,
  onDialog: (dialog: OpenDialog) => void,
  orgId: string | null = null,
): ConnectionProjects {
  const [projects, setProjects] = useState<TeamProject[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  // The list the last refresh showed, so a publish that ends since is announced once.
  const shown = useRef<TeamProject[] | null>(null);
  shown.current = projects;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
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
  }, [enabled, orgId, attempt]);

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

  return {
    projects,
    loadFailed,
    reload: () => setAttempt((count) => count + 1),
    opening,
    open,
    retrying,
    retry,
    changeVisibility,
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
      updatedAt={project.lastCommitAt ?? null}
      siteUrl={project.siteUrl ?? null}
      siteFramed={project.siteFrameable !== false}
      subtitle={project.fullName}
      isPublic={project.visibility === 'public'}
      badge={badge ?? undefined}
      deploy={deploy}
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
          <MenuItem
            action={() =>
              onDialog({ kind: 'history', project: ref, name: project.name, canRevert: canEdit, canFork: false })
            }
          >
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
  const connection = useConnectionProjects(true, onDialog, orgId);
  const { projects } = connection;

  return (
    <section aria-labelledby="team-projects" className="grid gap-4">
      <SectionHeading id="team-projects" action={action}>
        {heading}
      </SectionHeading>
      {connection.loadFailed ? (
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
