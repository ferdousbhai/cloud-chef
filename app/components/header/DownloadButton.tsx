import { CodeIcon, CounterClockwiseClockIcon, DownloadIcon } from '@radix-ui/react-icons';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { projectDialogStore } from '~/lib/stores/project-actions.client';
import { Button } from '@ui/Button';
import { MenuItem } from '@ui/Menu';

/**
 * The open project's code: its history, a clone command, and its files as they are in the workspace now
 * (edits not yet published included), zipped in the browser.
 */
export function DownloadButton() {
  return (
    <div className="flex items-center gap-1">
      <Button
        onClick={() => projectDialogStore.set('history')}
        variant="neutral"
        size="xs"
        icon={<CounterClockwiseClockIcon />}
      >
        History
      </Button>
      <Button onClick={() => projectDialogStore.set('clone')} variant="neutral" size="xs" icon={<CodeIcon />}>
        Clone
      </Button>
      <Button
        onClick={() => workbenchStore.downloadZip()}
        variant="neutral"
        size="xs"
        aria-label="Download code"
        tip="Download code"
      >
        <DownloadIcon />
        <span>Download Code</span>
      </Button>
    </div>
  );
}

export function MobileProjectMenuItems() {
  return (
    <>
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
    </>
  );
}
