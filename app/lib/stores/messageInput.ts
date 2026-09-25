import { atom } from 'nanostores';

export const messageInputStore = atom('');

let revision = 0;

/**
 * The revision marks a change of content. Re-setting the current text is not one: a remounting
 * prefill that restores the same draft must not look like an edit and void a pending clear.
 */
export function setMessageInput(value: string): void {
  if (value === messageInputStore.get()) {
    return;
  }
  revision++;
  messageInputStore.set(value);
}

export function getMessageInputRevision(): number {
  return revision;
}
