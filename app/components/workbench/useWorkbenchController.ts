import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { chatStore, useChatId } from '~/lib/stores/chatId';
import { messageOf } from '~/lib/json-request';

const logger = createScopedLogger('WorkbenchController');

export function useWorkbenchController(isStreaming?: boolean) {
  const projectId = useChatId();
  const previewState = useStore(workbenchStore.previewState);
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const selectedFile = useStore(workbenchStore.selectedFile);
  const currentDocument = useStore(workbenchStore.currentDocument);
  const unsavedFiles = useStore(workbenchStore.unsavedFiles);
  const files = useStore(workbenchStore.files);
  const selectedView = useStore(workbenchStore.currentView);
  const following = useStore(workbenchStore.followingStreamedCode);
  const linkedProject = useStore(workbenchStore.linkedProject);
  const conversationClosed = useStore(workbenchStore.conversationClosed);
  const isSmallViewport = useViewport();
  const workspaceId = workbenchStore.getActiveWorkspaceId();
  const [hasLoadedPreview, setHasLoadedPreview] = useState(false);
  const [previewRequestState, setPreviewRequestState] = useState({ projectId, workspaceId, requesting: false });
  const previewRequestVersionRef = useRef(0);
  const manualPreviewRequestRef = useRef<symbol | null>(null);
  const previewRequesting =
    previewRequestState.projectId === projectId &&
    previewRequestState.workspaceId === workspaceId &&
    previewRequestState.requesting;
  const hasPreview = previewState.published !== null;
  const invalidatePreviewRequests = useCallback(() => {
    previewRequestVersionRef.current++;
    manualPreviewRequestRef.current = null;
  }, []);
  /**
   * Claim the preview lane for one request. Its result is applied only while the workspace it was
   * issued against is still the active one and no later request has superseded it.
   */
  const beginPreviewRequest = useCallback(() => {
    const workspaceId = workbenchStore.getActiveWorkspaceId();
    const requestVersion = ++previewRequestVersionRef.current;
    return {
      workspaceId,
      isCurrentRequest: () =>
        workspaceId !== null &&
        workbenchStore.isWorkspaceActive(workspaceId) &&
        previewRequestVersionRef.current === requestVersion,
    };
  }, []);

  useEffect(() => {
    invalidatePreviewRequests();
    return invalidatePreviewRequests;
  }, [invalidatePreviewRequests, projectId, workspaceId]);

  useEffect(() => {
    if (hasPreview) {
      workbenchStore.currentView.set('preview');
    }
  }, [hasPreview]);

  useEffect(() => {
    if (selectedView === 'preview') {
      setHasLoadedPreview(true);
    }
  }, [selectedView]);

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
    const { isCurrentRequest } = beginPreviewRequest();
    void (async () => {
      try {
        await workbenchStore.saveCurrentDocument();
      } catch (error) {
        logger.error('Failed to save the file', error);
        if (isCurrentRequest()) {
          toast.error('Save failed');
        }
        return;
      }
      // A GitHub project previews through its repository's pipeline, so a save has no preview to update.
      if (!isCurrentRequest() || workbenchStore.linkedProject.get()) {
        return;
      }
      try {
        const preview = await workbenchStore.requestPreview();
        if (isCurrentRequest()) {
          workbenchStore.updatePreview(preview);
        }
      } catch (error) {
        logger.warn('Failed to update the preview after a file save', error);
        if (isCurrentRequest()) {
          toast.error('Preview update failed');
        }
      }
    })();
  }, [beginPreviewRequest]);

  const onPreviewRequest = useCallback(async () => {
    const { workspaceId, isCurrentRequest } = beginPreviewRequest();
    const manualRequest = Symbol('manual-preview-request');
    manualPreviewRequestRef.current = manualRequest;
    setPreviewRequestState({ projectId, workspaceId, requesting: true });
    try {
      const preview = await workbenchStore.requestPreview();
      if (isCurrentRequest()) {
        workbenchStore.updatePreview(preview);
      }
    } catch (error) {
      if (isCurrentRequest()) {
        toast.error(messageOf(error, 'Unable to queue a remote preview.'));
      }
    } finally {
      if (manualPreviewRequestRef.current === manualRequest) {
        manualPreviewRequestRef.current = null;
        setPreviewRequestState({ projectId, workspaceId, requesting: false });
      }
    }
  }, [beginPreviewRequest, projectId]);

  return {
    close: () => {
      chatStore.setKey('showChat', true);
      workbenchStore.showWorkbench.set(false);
    },
    currentDocument,
    files,
    hasLoadedPreview,
    linkedProject,
    conversationClosed,
    isSmallViewport,
    onEditorChange,
    onEditorScroll,
    onEditorWheel,
    onFileReset: () => workbenchStore.resetCurrentDocument(),
    onFileSave,
    onFileSelect,
    onPreviewRequest,
    previewRequesting,
    previewState,
    projectId,
    selectedFile,
    selectedView,
    setSelectedView: (view: WorkbenchViewType) => workbenchStore.currentView.set(view),
    showWorkbench,
    unsavedFiles,
    scrollToDocAppend: following && isStreaming,
  };
}
