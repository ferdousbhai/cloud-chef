import { CheckIcon, PlusIcon } from '@radix-ui/react-icons';
import { useNavigate } from '@tanstack/react-router';
import { Menu, MenuItem } from '@ui/Menu';
import { authClient, switchWorkspace } from '~/lib/auth-client';
import { toast } from 'sonner';
import type { WorkspaceContext } from '~/lib/.server/auth';

/**
 * Which Cloudflare account the builder works in: the person's own, or an organization's they belong
 * to. Always there once signed in, so organizations can be found: it lists every account to switch to,
 * and leads to creating and managing organizations.
 */
export function WorkspaceSwitcher() {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  if (!session) {
    return null;
  }
  const current = session.context;
  const organizations = () => void navigate({ to: '/settings', hash: 'organizations' });
  return (
    <Menu
      buttonProps={{
        variant: 'subtle',
        size: 'xs',
        // The button names the workspace briefly; its Cloudflare account is in the tooltip and the menu.
        title: current ? `${fullLabel(current)}. Switch account or manage organizations` : 'Manage organizations',
        children: <span className="max-w-56 truncate">{current ? shortLabel(current) : 'No workspace'}</span>,
      }}
    >
      {session.contexts.map((option) => (
        <MenuItem
          key={option.connectionId}
          action={() => {
            if (option.connectionId !== current?.connectionId) {
              void switchTo(option.connectionId);
            }
          }}
        >
          <CheckIcon aria-hidden className={option.connectionId === current?.connectionId ? '' : 'invisible'} />
          <span className="flex flex-col">
            <span>{shortLabel(option)}</span>
            {option.accountName ? <span className="text-xs text-content-tertiary">{option.accountName}</span> : null}
          </span>
        </MenuItem>
      ))}
      <MenuItem action={organizations}>
        <PlusIcon aria-hidden />
        {session.contexts.some((option) => option.kind === 'organization')
          ? 'Manage organizations'
          : 'Create an organization'}
      </MenuItem>
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

function shortLabel(option: WorkspaceContext) {
  return option.kind === 'organization' ? option.orgName : 'Personal';
}

function fullLabel(option: WorkspaceContext) {
  return option.accountName ? `${shortLabel(option)} · ${option.accountName}` : shortLabel(option);
}
