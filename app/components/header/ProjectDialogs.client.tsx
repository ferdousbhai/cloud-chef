import { useStore } from '@nanostores/react';
import { useEffect } from 'react';
import { CloneDialog } from '~/components/projects/CloneDialog.client';
import { ProjectHistoryDialog } from '~/components/projects/ProjectHistoryDialog.client';
import { ShareProjectDialog } from '~/components/projects/ShareProjectDialog.client';
import { projectShareStore } from '~/lib/cloudflare/project-presence.client';
import { useWorkspaceId } from '~/lib/stores/workspaceId';
import { description } from '~/lib/stores/description';
import { projectDialogStore } from '~/lib/stores/project-actions.client';
import { workbenchStore } from '~/lib/stores/workbench.client';

/** The open project's Share, History and Clone dialogs, opened from its menu in the header. */
export function ProjectDialogs() {
  const open = useStore(projectDialogStore);
  const workspaceId = useWorkspaceId();
  const title = useStore(description);
  const linkedProject = useStore(workbenchStore.linkedProject);
  const conversationClosed = useStore(workbenchStore.conversationClosed);
  const shareable = useStore(projectShareStore);
  const name = linkedProject?.repository ?? (title?.trim() || 'Untitled project');
  const project = { chatInitialId: workspaceId };
  const close = () => projectDialogStore.set(null);
  // Leaving the project closes its dialogs, so another project never opens on one.
  useEffect(() => () => projectDialogStore.set(null), [workspaceId]);

  if (open === 'history') {
    return <ProjectHistoryDialog project={project} name={name} canRevert={!conversationClosed} onClose={close} />;
  }
  if (open === 'share' && shareable) {
    return <ShareProjectDialog project={{ id: shareable, name }} onClose={close} />;
  }
  if (open === 'clone') {
    return <CloneDialog project={project} name={name} onClose={close} />;
  }
  return null;
}
