import { api } from '~/lib/cloudflare/data-api';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { description as descriptionStore } from '~/lib/stores/description';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { useChatId } from '~/lib/stores/chatId';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';

const logger = createScopedLogger('useEditChatDescription');
const inFlightDescriptionSubmissions = new Map<string, symbol>();

type DescriptionValidationResult = 'valid' | 'unchanged' | 'invalidLength' | 'invalidCharacters';

interface EditChatDescriptionOptions {
  initialDescription?: string;
  customChatId?: string;
  syncWithGlobalStore?: boolean;
}

type EditChatDescriptionHook = {
  editing: boolean;
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleBlur: () => Promise<void>;
  handleSubmit: (event: React.FormEvent) => Promise<void>;
  handleKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => Promise<void>;
  currentDescription: string;
  toggleEditMode: () => void;
};

/**
 * Hook to manage the state and behavior for editing chat descriptions.
 *
 * Offers functions to:
 * - Switch between edit and view modes.
 * - Manage input changes, blur, and form submission events.
 */
export function useEditChatDescription({
  initialDescription = descriptionStore.get() ?? '',
  customChatId,
  syncWithGlobalStore,
}: EditChatDescriptionOptions): EditChatDescriptionHook {
  const chatIdFromRoute = useChatId();
  const userId = useUserIdOrNullOrLoading();
  const chatId = customChatId || chatIdFromRoute;
  const editScope = `${chatId ?? ''}:${userId ?? ''}:${syncWithGlobalStore ? 'global' : 'local'}`;
  const [editingState, setEditingState] = useState({ scope: editScope, value: false });
  const [descriptionState, setDescriptionState] = useState({
    scope: editScope,
    initialDescription,
    value: initialDescription,
  });
  const editing = editingState.scope === editScope && editingState.value;
  const currentDescription =
    descriptionState.scope === editScope && descriptionState.initialDescription === initialDescription
      ? descriptionState.value
      : initialDescription;
  const interactionVersionRef = useRef(0);
  const submittingRef = useRef<symbol | null>(null);
  const canonicalDescriptionRef = useRef(initialDescription);
  const cancelPendingInteractions = useCallback(() => {
    interactionVersionRef.current++;
    submittingRef.current = null;
  }, []);

  useLayoutEffect(() => {
    canonicalDescriptionRef.current = initialDescription;
    interactionVersionRef.current++;
  }, [initialDescription]);

  useLayoutEffect(() => {
    cancelPendingInteractions();
    const canonicalDescription = canonicalDescriptionRef.current;
    setEditingState({ scope: editScope, value: false });
    setDescriptionState({
      scope: editScope,
      initialDescription: canonicalDescription,
      value: canonicalDescription,
    });

    return cancelPendingInteractions;
  }, [cancelPendingInteractions, editScope]);

  const toggleEditMode = useCallback(() => {
    interactionVersionRef.current++;
    setEditingState((current) => ({
      scope: editScope,
      value: current.scope === editScope ? !current.value : true,
    }));
  }, [editScope]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      interactionVersionRef.current++;
      setDescriptionState({ scope: editScope, initialDescription, value: e.target.value });
    },
    [editScope, initialDescription],
  );

  const fetchLatestDescription = useCallback(async () => {
    if (!chatId || !userId) {
      return initialDescription;
    }

    try {
      const chat = await executeDataOperation(api.messages.get, { id: chatId, sessionId: userId });
      return chat?.description || initialDescription;
    } catch (error) {
      logger.error('Failed to fetch latest description:', error);
      return initialDescription;
    }
  }, [chatId, userId, initialDescription]);

  const handleBlur = useCallback(async () => {
    if (submittingRef.current) {
      return;
    }
    const interactionVersion = ++interactionVersionRef.current;
    const latestDescription = await fetchLatestDescription();
    if (submittingRef.current || interactionVersionRef.current !== interactionVersion) {
      return;
    }
    setDescriptionState({ scope: editScope, initialDescription, value: latestDescription });
    setEditingState({ scope: editScope, value: false });
  }, [editScope, fetchLatestDescription, initialDescription]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const resourceKey = JSON.stringify([chatId, userId]);
      if (inFlightDescriptionSubmissions.has(resourceKey)) {
        return;
      }

      const submittedDescription = currentDescription.trim();
      interactionVersionRef.current++;

      const validationResult = validateDescription(submittedDescription, initialDescription);
      if (validationResult === 'unchanged') {
        setEditingState({ scope: editScope, value: false });
        return;
      }
      if (validationResult === 'invalidLength') {
        toast.error('Description must be between 1 and 100 characters.');
        return;
      }
      if (validationResult === 'invalidCharacters') {
        toast.error('Description can only contain letters, numbers, spaces, basic punctuation, and inline Markdown.');
        return;
      }

      const submission = Symbol('description-submission');
      inFlightDescriptionSubmissions.set(resourceKey, submission);
      submittingRef.current = submission;

      try {
        if (!chatId || !userId) {
          toast.error('Chat Id is not available');
          return;
        }

        await executeDataOperation(api.messages.setDescription, {
          id: chatId,
          sessionId: userId,
          description: submittedDescription,
        });
        if (submittingRef.current !== submission) {
          return;
        }

        setDescriptionState({
          scope: editScope,
          initialDescription: canonicalDescriptionRef.current,
          value: submittedDescription,
        });
        if (syncWithGlobalStore) {
          descriptionStore.set(submittedDescription);
        }

        toast.success('Chat description updated successfully');
      } catch (error) {
        if (submittingRef.current === submission) {
          toast.error('Failed to update chat description: ' + errorMessage(error));
        }
      } finally {
        if (inFlightDescriptionSubmissions.get(resourceKey) === submission) {
          inFlightDescriptionSubmissions.delete(resourceKey);
        }
        if (submittingRef.current === submission) {
          submittingRef.current = null;
          setEditingState({ scope: editScope, value: false });
        }
      }
    },
    [currentDescription, chatId, editScope, initialDescription, syncWithGlobalStore, userId],
  );

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        await handleBlur();
      }
    },
    [handleBlur],
  );

  return {
    editing,
    handleChange,
    handleBlur,
    handleSubmit,
    handleKeyDown,
    currentDescription,
    toggleEditMode,
  };
}

function validateDescription(description: string, initialDescription: string): DescriptionValidationResult {
  const trimmedDescription = description.trim();

  if (trimmedDescription === initialDescription) {
    return 'unchanged';
  }

  if (trimmedDescription.length === 0 || trimmedDescription.length > 100) {
    return 'invalidLength';
  }

  return /^[a-zA-Z0-9\s\-_.,!?()[\]{}'"*~`]+$/.test(trimmedDescription) ? 'valid' : 'invalidCharacters';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
