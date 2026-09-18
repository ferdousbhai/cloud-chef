import { useStore } from '@nanostores/react';
import { useEditChatDescription } from '~/lib/hooks/useEditChatDescription';
import { description as descriptionStore } from '~/lib/stores/description';
import { CheckIcon, Pencil1Icon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { ProjectTitle } from '~/components/ProjectTitle';

export function ChatDescription() {
  const initialDescription = useStore(descriptionStore) ?? '';

  const { editing, handleChange, handleBlur, handleSubmit, handleKeyDown, currentDescription, toggleEditMode } =
    useEditChatDescription({
      initialDescription,
      syncWithGlobalStore: true,
    });

  if (!initialDescription) {
    // Avoid exposing the rename control until a title is available.
    return null;
  }

  return (
    <div className="flex min-w-0 w-full items-center justify-center">
      {editing ? (
        <form onSubmit={handleSubmit} className="flex min-w-0 max-w-full items-center justify-center">
          <TextInput
            autoFocus
            className="mr-2 min-w-0 flex-1"
            id="chat-description"
            aria-label="Project name"
            value={currentDescription}
            onChange={handleChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />
          <Button variant="neutral" onClick={handleSubmit} icon={<CheckIcon />} inline size="xs" tip="Save title" />
        </form>
      ) : (
        <button
          type="button"
          className="group flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-transparent px-1.5 py-1 text-sm font-semibold text-content-primary outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          title={`${currentDescription} — click to rename`}
          aria-label={`Rename project: ${currentDescription}`}
          onClick={toggleEditMode}
        >
          <ProjectTitle className="block min-w-0 flex-1 truncate">{currentDescription}</ProjectTitle>
          <Pencil1Icon
            className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden
          />
        </button>
      )}
    </div>
  );
}
