import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useState } from 'react';
import { getAbsolutePath } from 'cloudchef-agent/utils/workDir';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { toast } from 'sonner';
import type {
  OnChangeCallback as OnEditorChange,
  OnScrollCallback as OnEditorScroll,
  OnWheelCallback as OnEditorWheel,
} from '~/components/editor/codemirror/CodeMirrorEditor';
import useViewport from '~/lib/hooks/useViewport';
import { workbenchStore, type WorkbenchViewType } from '~/lib/stores/workbench.client';
import { chatStore, useWorkspaceId } from '~/lib/stores/workspaceId';

const logger = createScopedLogger('WorkbenchController');

export function useWorkbenchController(isStreaming?: boolean) {
  const projectId = useWorkspaceId();
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const selectedFile = useStore(workbenchStore.selectedFile);
  const currentDocument = useStore(workbenchStore.currentDocument);
  const unsavedFiles = useStore(workbenchStore.unsavedFiles);
  const files = useStore(workbenchStore.files);
  const selectedView = useStore(workbenchStore.currentView);
  const following = useStore(workbenchStore.followingStreamedCode);
  const linkedProject = useStore(workbenchStore.linkedProject);
  const linkedSite = useStore(workbenchStore.linkedSite);
  const conversationClosed = useStore(workbenchStore.conversationClosed);
  const isSmallViewport = useViewport();
  const [hasLoadedPreview, setHasLoadedPreview] = useState(false);
  const [hasLoadedTerminal, setHasLoadedTerminal] = useState(false);
  if (selectedView === 'preview' && !hasLoadedPreview) {
    setHasLoadedPreview(true);
  }
  // The shell is opened only once someone asks for it, and then stays attached while the page is open.
  if (selectedView === 'terminal' && !hasLoadedTerminal) {
    setHasLoadedTerminal(true);
  }

  useEffect(() => {
    workbenchStore.setDocuments(files);
  }, [files]);

  const onEditorChange = useCallback<OnEditorChange>(
    (update) => {
      const updatePath = getAbsolutePath(update.filePath);
      if (update.projectId !== projectId) {
        return;
      }
      workbenchStore.setDocumentContent(updatePath, update.content);
    },
    [projectId],
  );

  const onEditorScroll = useCallback<OnEditorScroll>(
    (position) => workbenchStore.setCurrentDocumentScrollPosition(position),
    [],
  );
  const onEditorWheel = useCallback<OnEditorWheel>(() => workbenchStore.followingStreamedCode.set(false), []);
  const onFileSelect = useCallback((filePath: string | undefined) => {
    workbenchStore.flushPendingEditorChange();
    workbenchStore.followingStreamedCode.set(false);
    workbenchStore.setSelectedFile(filePath ? getAbsolutePath(filePath) : undefined);
  }, []);
  const onFileSave = useCallback(() => {
    // A conversation a newer one took over is kept to read: only the newest one changes the project.
    if (workbenchStore.conversationClosed.get()) {
      return;
    }
    workbenchStore.flushPendingEditorChange();
    const workspaceId = workbenchStore.getActiveWorkspaceId();
    void workbenchStore.saveCurrentDocument().catch((error) => {
      logger.error('Failed to save the file', error);
      if (workspaceId !== null && workbenchStore.isWorkspaceActive(workspaceId)) {
        toast.error('Save failed');
      }
    });
  }, []);

  return {
    close: () => {
      chatStore.setKey('showChat', true);
      workbenchStore.showWorkbench.set(false);
    },
    currentDocument,
    files,
    hasLoadedPreview,
    hasLoadedTerminal,
    linkedProject,
    linkedSite,
    conversationClosed,
    isSmallViewport,
    onEditorChange,
    onEditorScroll,
    onEditorWheel,
    onFileReset: () => workbenchStore.resetCurrentDocument(),
    onFileSave,
    onFileSelect,
    projectId,
    selectedFile,
    selectedView,
    setSelectedView: (view: WorkbenchViewType) => workbenchStore.currentView.set(view),
    showWorkbench,
    unsavedFiles,
    scrollToDocAppend: following && isStreaming,
  };
}
