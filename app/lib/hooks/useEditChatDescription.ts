import { api } from '~/lib/cloudflare/data-api';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { description as descriptionStore } from '~/lib/stores/description';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { useWorkspaceId } from '~/lib/stores/workspaceId';
import { messageOf } from '~/lib/json-request';

/** The data API's own limit; any characters are allowed, as in a generated title. */
const MAX_DESCRIPTION_LENGTH = 200;

interface EditChatDescriptionOptions {
  initialDescription: string;
  customChatId?: string;
  syncWithGlobalStore?: boolean;
}

/** The edit of one chat's name, from the name it started from: another chat or a new name starts over. */
type EditState = { workspaceId: string | undefined; initialDescription: string; editing: boolean; value: string };

/** Editing a chat's name: a valid change is saved, and leaving the field or Escape puts the name back. */
export function useEditChatDescription({
  initialDescription,
  customChatId,
  syncWithGlobalStore,
}: EditChatDescriptionOptions) {
  const chatIdFromRoute = useWorkspaceId();
  const userId = useUserIdOrNullOrLoading();
  const workspaceId = customChatId || chatIdFromRoute;
  const [state, setState] = useState<EditState>({
    workspaceId,
    initialDescription,
    editing: false,
    value: initialDescription,
  });
  const current: EditState =
    state.workspaceId !== workspaceId
      ? { workspaceId, initialDescription, editing: false, value: initialDescription }
      : state.initialDescription !== initialDescription
        ? { ...state, initialDescription, value: initialDescription }
        : state;
  /** The chat whose name is being saved: one save at a time, so saves cannot land out of order. */
  const submittingRef = useRef<string | null>(null);

  const revert = () => {
    if (submittingRef.current !== workspaceId) {
      setState({ ...current, editing: false, value: initialDescription });
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!workspaceId || !userId || submittingRef.current === workspaceId) {
      return;
    }
    const description = current.value.trim();
    if (description === initialDescription) {
      setState({ ...current, editing: false, value: initialDescription });
      return;
    }
    if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
      toast.error(`Description must be between 1 and ${MAX_DESCRIPTION_LENGTH} characters.`);
      return;
    }
    submittingRef.current = workspaceId;
    try {
      await executeDataOperation(api.messages.setDescription, { id: workspaceId, description });
      setState((latest) => (latest.workspaceId === workspaceId ? { ...latest, value: description } : latest));
      if (syncWithGlobalStore) {
        descriptionStore.set(description);
      }
      toast.success('Chat description updated successfully');
    } catch (error) {
      toast.error('Failed to update chat description: ' + messageOf(error, 'unknown error'));
    } finally {
      if (submittingRef.current === workspaceId) {
        submittingRef.current = null;
      }
      setState((latest) => (latest.workspaceId === workspaceId ? { ...latest, editing: false } : latest));
    }
  };

  return {
    editing: current.editing,
    currentDescription: current.value,
    toggleEditMode: () => setState({ ...current, editing: !current.editing }),
    handleChange: (event: React.ChangeEvent<HTMLInputElement>) => setState({ ...current, value: event.target.value }),
    handleBlur: revert,
    handleKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        revert();
      }
    },
    handleSubmit,
  };
}
