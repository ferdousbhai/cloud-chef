import { atom } from 'nanostores';

/** Which of the open project's dialogs the header shows. The header's phone menu closes before one opens. */
export const projectDialogStore = atom<'history' | 'clone' | null>(null);

/**
 * Reverts the open project's workspace to a commit, through the builder agent the chat is connected to.
 * Null outside a connected chat, where there is no workspace to change.
 */
export const projectRevertStore = atom<((commit: string) => Promise<{ changed: boolean }>) | null>(null);
