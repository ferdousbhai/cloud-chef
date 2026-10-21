import { useEffect } from 'react';
import { useBlocker, type ShouldBlockFn } from '@tanstack/react-router';

const LEAVE_WITH_UNSAVED_EDITS =
  'You have editor changes that are not saved yet. Leave this project anyway and discard them?';

/**
 * Whether the mounted guard holds edits at risk, and whether the person already agreed to discard them
 * for a page leave under way, so the unload that leave ends in lets the page go without asking again.
 */
const pageLeave = { editsAtRisk: false, agreed: false };

/**
 * Leaving the page's path opens another project or page and drops the editor's buffers; moving within the
 * same chat (a subchat, a search or hash change) keeps them, and the subchat bar guards its own switches.
 */
const confirmLeavingUnsavedEdits: ShouldBlockFn = ({ current, next }) =>
  current.pathname !== next.pathname && !window.confirm(LEAVE_WITH_UNSAVED_EDITS);

/**
 * While the editor holds edits not yet in the workspace, asks before an in-app navigation leaves the
 * project, and has the browser ask before a reload, tab close, or full-document link (such as "Start
 * new project") unloads the page, unless the person already agreed through `leavePage`.
 */
export function useUnsavedEditsGuard(editsAtRisk: boolean): void {
  useEffect(() => {
    pageLeave.editsAtRisk = editsAtRisk;
    return () => {
      pageLeave.editsAtRisk = false;
    };
  }, [editsAtRisk]);
  useEffect(
    () => () => {
      pageLeave.agreed = false;
    },
    [],
  );
  useBlocker({
    shouldBlockFn: confirmLeavingUnsavedEdits,
    enableBeforeUnload: () => !pageLeave.agreed,
    disabled: !editsAtRisk,
  });
}

/**
 * Runs `leave`, an action that ends by unloading the page (signing out, switching account, opening
 * another conversation), after asking once whether to discard edits the guard holds at risk, so its
 * server steps never happen for someone who then stays. Resolves false, without running it, when they
 * stay; if `leave` fails the page is guarded again.
 */
export async function leavePage(leave: () => Promise<void>): Promise<boolean> {
  if (pageLeave.editsAtRisk) {
    if (!window.confirm(LEAVE_WITH_UNSAVED_EDITS)) {
      return false;
    }
    pageLeave.agreed = true;
  }
  try {
    await leave();
  } catch (error) {
    pageLeave.agreed = false;
    throw error;
  }
  return true;
}
