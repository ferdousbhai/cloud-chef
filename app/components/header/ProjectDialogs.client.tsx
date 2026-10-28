import { useStore } from '@nanostores/react';
import { useEffect } from 'react';
import { CloneDialog } from '~/components/projects/CloneDialog.client';
import { ProjectHistoryDialog } from '~/components/projects/ProjectHistoryDialog.client';
import { openProjectWorkspace } from '~/lib/cloudflare/projects.client';
import { useWorkspaceId } from '~/lib/stores/workspaceId';
import { description } from '~/lib/stores/description';
import { projectDialogStore } from '~/lib/stores/project-actions.client';
import { workbenchStore } from '~/lib/stores/workbench.client';

/** The open project's History and Clone dialogs, opened from the header. */
export function ProjectDialogs() {
  const open = useStore(projectDialogStore);
  const workspaceId = useWorkspaceId();
  const title = useStore(description);
  // A team project's conversation reverts in its workspace too, but a fork is made from one's own projects.
  const linkedProject = useStore(workbenchStore.linkedProject);
  const conversationClosed = useStore(workbenchStore.conversationClosed);
  const name = title?.trim() || 'Untitled project';
  const project = { chatInitialId: workspaceId };
  const close = () => projectDialogStore.set(null);
  // Leaving the project closes its dialogs, so another project never opens on one.
  useEffect(() => () => projectDialogStore.set(null), [workspaceId]);

  if (open === 'history') {
    return (
      <ProjectHistoryDialog
        project={project}
        name={name}
        canRevert={!conversationClosed}
        canFork={linkedProject === null}
        teamProject={linkedProject !== null}
        onOpenProject={openProjectWorkspace}
        onClose={close}
      />
    );
  }
  if (open === 'clone') {
    return <CloneDialog project={project} name={name} onClose={close} />;
  }
  return null;
}
