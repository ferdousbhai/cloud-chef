import { debounce } from '~/utils/debounce';
import type { EditorUpdate, OnChangeCallback } from './editor-types';

type PendingEditorUpdate = {
  callback: OnChangeCallback | undefined;
  update: EditorUpdate;
};

/**
 * Keep the callback and document identity that were active when an edit was
 * made. Flush boundaries can then deliver the edit exactly once without ever
 * rebinding it to a newly selected project or file.
 */
export function createEditorChangeBuffer(wait: number) {
  const deliver = debounce(({ callback, update }: PendingEditorUpdate) => callback?.(update), wait);
  return {
    queue: (pending: PendingEditorUpdate) => deliver(pending),
    flush: deliver.flush,
    cancel: deliver.cancel,
  };
}
