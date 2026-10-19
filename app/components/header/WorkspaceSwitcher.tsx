import { CheckIcon } from '@radix-ui/react-icons';
import { Menu, MenuItem } from '@ui/Menu';
import { authClient, switchWorkspace } from '~/lib/auth-client';
import { toast } from 'sonner';
import type { WorkspaceContext } from '~/lib/.server/auth';

/**
 * Which Cloudflare account the builder works in: the person's own, or an organization's they belong
 * to. Shown only when there is more than one to choose from.
 */
export function WorkspaceSwitcher() {
  const { data: session } = authClient.useSession();
  if (!session?.context || session.contexts.length < 2) {
    return null;
  }
  const current = session.context;
  return (
    <Menu
      buttonProps={{
        variant: 'subtle',
        size: 'xs',
        title: 'Switch account',
        children: <span className="max-w-40 truncate">{workspaceLabel(current)}</span>,
      }}
    >
      {session.contexts.map((option) => (
        <MenuItem
          key={option.connectionId}
          action={() => {
            if (option.connectionId !== current.connectionId) {
              void switchTo(option.connectionId);
            }
          }}
        >
          <CheckIcon aria-hidden className={option.connectionId === current.connectionId ? '' : 'invisible'} />
          {workspaceLabel(option)}
        </MenuItem>
      ))}
    </Menu>
  );
}

async function switchTo(connectionId: string) {
  try {
    await switchWorkspace(connectionId);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Unable to switch accounts.');
  }
}

function workspaceLabel(option: WorkspaceContext) {
  return option.kind === 'organization'
    ? option.orgName
    : `Personal${option.accountName ? ` · ${option.accountName}` : ''}`;
}
