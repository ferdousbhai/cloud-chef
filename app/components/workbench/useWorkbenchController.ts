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
  const siteState = useStore(workbenchStore.siteState);
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
  const workspaceId = workbenchStore.getActiveWorkspaceId();
  const [hasLoadedPreview, setHasLoadedPreview] = useState(false);
  const [publishRequestState, setPublishRequestState] = useState({ projectId, workspaceId, requesting: false });
  const publishRequestVersionRef = useRef(0);
  const manualPublishRequestRef = useRef<symbol | null>(null);
  const publishRequesting =
    publishRequestState.projectId === projectId &&
    publishRequestState.workspaceId === workspaceId &&
    publishRequestState.requesting;
  const hasSite = siteState.url !== null;
  const invalidatePublishRequests = useCallback(() => {
    publishRequestVersionRef.current++;
    manualPublishRequestRef.current = null;
  }, []);
  /**
   * Claim the publish lane for one request. Its failure is reported only while the workspace it was
   * issued against is still the active one and no later request has superseded it.
   */
  const beginPublishRequest = useCallback(() => {
    const workspaceId = workbenchStore.getActiveWorkspaceId();
    const requestVersion = ++publishRequestVersionRef.current;
    return {
      workspaceId,
      isCurrentRequest: () =>
        workspaceId !== null &&
        workbenchStore.isWorkspaceActive(workspaceId) &&
        publishRequestVersionRef.current === requestVersion,
    };
  }, []);

  useEffect(() => {
    invalidatePublishRequests();
    return invalidatePublishRequests;
  }, [invalidatePublishRequests, projectId, workspaceId]);

  useEffect(() => {
    if (hasSite) {
      workbenchStore.currentView.set('preview');
    }
  }, [hasSite]);

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
    const { isCurrentRequest } = beginPublishRequest();
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
      // A GitHub project publishes through its repository's pipeline, so a save publishes nothing here.
      if (!isCurrentRequest() || workbenchStore.linkedProject.get()) {
        return;
      }
      try {
        await workbenchStore.publishSite();
      } catch (error) {
        logger.warn('Failed to publish the app after a file save', error);
        if (isCurrentRequest()) {
          toast.error('Publishing the app failed');
        }
      }
    })();
  }, [beginPublishRequest]);

  const onPublishRequest = useCallback(async () => {
    const { workspaceId, isCurrentRequest } = beginPublishRequest();
    const manualRequest = Symbol('manual-publish-request');
    manualPublishRequestRef.current = manualRequest;
    setPublishRequestState({ projectId, workspaceId, requesting: true });
    try {
      await workbenchStore.publishSite();
    } catch (error) {
      if (isCurrentRequest()) {
        toast.error(messageOf(error, 'Unable to publish the app.'));
      }
    } finally {
      if (manualPublishRequestRef.current === manualRequest) {
        manualPublishRequestRef.current = null;
        setPublishRequestState({ projectId, workspaceId, requesting: false });
      }
    }
  }, [beginPublishRequest, projectId]);

  return {
    close: () => {
      chatStore.setKey('showChat', true);
      workbenchStore.showWorkbench.set(false);
    },
    currentDocument,
    files,
    hasLoadedPreview,
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
    onPublishRequest,
    publishRequesting,
    siteState,
    projectId,
    selectedFile,
    selectedView,
    setSelectedView: (view: WorkbenchViewType) => workbenchStore.currentView.set(view),
    showWorkbench,
    unsavedFiles,
    scrollToDocAppend: following && isStreaming,
  };
}
