import { useStore } from '@nanostores/react';
import { useEditChatDescription } from '~/lib/hooks/useEditChatDescription';
import { description as descriptionStore } from '~/lib/stores/description';
import {
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  CounterClockwiseClockIcon,
  DownloadIcon,
  Pencil1Icon,
} from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { Menu, MenuItem } from '@ui/Menu';
import { TextInput } from '@ui/TextInput';
import { ProjectTitle } from '~/components/ProjectTitle';
import { projectDialogStore } from '~/lib/stores/project-actions.client';
import { workbenchStore } from '~/lib/stores/workbench.client';

/**
 * The open project's name, and its menu: renaming it, its history, a clone command, and its files as they are in
 * the workspace now (edits not yet published included), zipped in the browser. A team or imported project goes by
 * its own name, which isn't renamed here.
 */
export function ProjectMenu() {
  const initialDescription = useStore(descriptionStore) ?? '';
  const linkedProject = useStore(workbenchStore.linkedProject);

  const { editing, handleChange, handleBlur, handleSubmit, handleKeyDown, currentDescription, toggleEditMode } =
    useEditChatDescription({
      initialDescription,
      syncWithGlobalStore: true,
    });

  const name = linkedProject?.repository ?? currentDescription;
  if (!name) {
    // Avoid exposing the menu until a name is available.
    return null;
  }

  if (editing) {
    return (
      <form onSubmit={handleSubmit} className="flex min-w-0 max-w-full items-center">
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
        <Button
          variant="neutral"
          onClick={handleSubmit}
          // Keeps the field focused, so leaving it does not put the name back before this saves it.
          onMouseDown={(event) => event.preventDefault()}
          icon={<CheckIcon />}
          inline
          size="xs"
          tip="Save name"
        />
      </form>
    );
  }

  return (
    <Menu
      align="start"
      buttonProps={{
        variant: 'subtle',
        size: 'xs',
        className: 'min-w-0 max-w-full shrink! text-sm font-semibold text-content-primary!',
        title: `${name}: project menu`,
        children: (
          <>
            <ProjectTitle className="block min-w-0 truncate">{name}</ProjectTitle>
            <ChevronDownIcon aria-hidden className="shrink-0" />
          </>
        ),
      }}
    >
      {linkedProject ? null : (
        <MenuItem action={toggleEditMode}>
          <Pencil1Icon />
          Rename
        </MenuItem>
      )}
      <MenuItem action={() => projectDialogStore.set('history')}>
        <CounterClockwiseClockIcon />
        History
      </MenuItem>
      <MenuItem action={() => projectDialogStore.set('clone')}>
        <CodeIcon />
        Clone
      </MenuItem>
      <MenuItem action={() => void workbenchStore.downloadZip()}>
        <DownloadIcon />
        Download code
      </MenuItem>
    </Menu>
  );
}
