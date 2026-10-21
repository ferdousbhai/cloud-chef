import { useBlocker, type ShouldBlockFn } from '@tanstack/react-router';

const LEAVE_WITH_UNSAVED_EDITS =
  'You have editor changes that are not saved yet. Leave this project anyway and discard them?';

/**
 * Leaving the page's path opens another project or page and drops the editor's buffers; moving within the
 * same chat (a subchat, a search or hash change) keeps them, and the subchat bar guards its own switches.
 */
const confirmLeavingUnsavedEdits: ShouldBlockFn = ({ current, next }) =>
  current.pathname !== next.pathname && !window.confirm(LEAVE_WITH_UNSAVED_EDITS);

/**
 * While the editor holds edits not yet in the workspace, asks before an in-app navigation leaves the
 * project, and has the browser ask before a reload, tab close, or full-document link (such as "Start
 * new project") unloads the page.
 */
export function useUnsavedEditsGuard(editsAtRisk: boolean): void {
  useBlocker({
    shouldBlockFn: confirmLeavingUnsavedEdits,
    enableBeforeUnload: editsAtRisk,
    disabled: !editsAtRisk,
  });
}
