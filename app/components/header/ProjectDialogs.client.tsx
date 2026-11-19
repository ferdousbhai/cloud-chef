import { useStore } from '@nanostores/react';
import { useEffect, useState } from 'react';
import { CloneDialog } from '~/components/projects/CloneDialog.client';
import { CopyProjectDialog } from '~/components/projects/CopyProjectDialog.client';
import { ProjectHistoryDialog } from '~/components/projects/ProjectHistoryDialog.client';
import { ShareProjectDialog } from '~/components/projects/ShareProjectDialog.client';
import { projectShareStore } from '~/lib/cloudflare/project-presence.client';
import { loadGitProjectId, openProjectWorkspace } from '~/lib/cloudflare/projects.client';
import { useWorkspaceId } from '~/lib/stores/workspaceId';
import { description } from '~/lib/stores/description';
import { projectDialogStore } from '~/lib/stores/project-actions.client';
import { workbenchStore } from '~/lib/stores/workbench.client';

/** The open project's Share, History, Clone and Make a copy dialogs, opened from its menu in the header. */
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
    return (
      <ProjectHistoryDialog
        project={project}
        name={name}
        canRevert={!conversationClosed && !linkedProject?.viewOnly}
        onClose={close}
      />
    );
  }
  if (open === 'share' && shareable) {
    return <ShareProjectDialog project={{ id: shareable, name }} onClose={close} />;
  }
  if (open === 'clone') {
    return <CloneDialog project={project} name={name} onClose={close} />;
  }
  if (open === 'copy') {
    return <CopyOpenProject chatInitialId={workspaceId} name={name} onClose={close} />;
  }
  return null;
}

/** Make a copy of the open project, once CloudChef says which project the chat is on; nothing shows until then. */
function CopyOpenProject({
  chatInitialId,
  name,
  onClose,
}: {
  chatInitialId: string;
  name: string;
  onClose: () => void;
}) {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let left = false;
    loadGitProjectId({ chatInitialId }).then(
      (found) => (left ? undefined : setId(found)),
      () => (left ? undefined : onClose()),
    );
    return () => {
      left = true;
    };
    // The chat is what the dialog was opened on: closing is the same each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatInitialId]);
  return id ? (
    <CopyProjectDialog project={{ id, name }} onOpenProject={openProjectWorkspace} onClose={onClose} />
  ) : null;
}
