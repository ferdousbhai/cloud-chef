import { CheckIcon, ChevronDownIcon, PlusIcon } from '@radix-ui/react-icons';
import { useNavigate } from '@tanstack/react-router';
import { Menu, MenuItem } from '@ui/Menu';
import { authClient } from '~/lib/auth-client';
import { switchAccount } from '~/lib/account-actions.client';
import type { WorkspaceContext } from '~/lib/.server/auth';

/**
 * Which Cloudflare account the builder works in: the person's own, or an organization's they belong
 * to. At the top of the projects sidebar, since it decides which projects are listed there; it lists every
 * account to switch to, and leads to creating and managing organizations.
 */
export function WorkspaceSwitcher({ className }: { className?: string }) {
  const { data: session } = authClient.useSession();
  if (!session) {
    return null;
  }
  const current = session.context;
  return (
    <Menu
      buttonProps={{
        variant: 'neutral',
        size: 'xs',
        className,
        // The button names the workspace briefly; its Cloudflare account is in the tooltip and the menu.
        title: current ? `${fullLabel(current)}. Switch account or manage teams` : 'Manage teams',
        children: (
          <>
            <span className="min-w-0 truncate">{current ? shortLabel(current) : 'No workspace'}</span>
            <ChevronDownIcon aria-hidden className="shrink-0" />
          </>
        ),
      }}
    >
      <WorkspaceMenuItems />
    </Menu>
  );
}

/** The switcher's items: every account to build in, the current one checked, then creating or managing organizations. */
function WorkspaceMenuItems() {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  if (!session) {
    return null;
  }
  const current = session.context;
  const organizations = () => void navigate({ to: '/settings', hash: 'organizations' });
  return (
    <>
      {session.contexts.map((option) => (
        <MenuItem
          key={option.connectionId}
          action={() => {
            if (option.connectionId !== current?.connectionId) {
              void switchAccount(option.connectionId);
            }
          }}
        >
          <CheckIcon aria-hidden className={option.connectionId === current?.connectionId ? '' : 'invisible'} />
          <span className="flex min-w-0 flex-col">
            <span className="wrap-break-word">{shortLabel(option)}</span>
            {option.accountName ? (
              <span className="wrap-break-word text-xs text-content-tertiary">{option.accountName}</span>
            ) : null}
          </span>
        </MenuItem>
      ))}
      <MenuItem action={organizations}>
        <PlusIcon aria-hidden />
        {/* The session lists only teams with a connected account, so a member of one still unconnected sees Teams too. */}
        {session.contexts.some((option) => option.kind === 'organization') ? 'Manage teams' : 'Teams'}
      </MenuItem>
    </>
  );
}

function shortLabel(option: WorkspaceContext) {
  return option.kind === 'organization' ? option.orgName : 'Personal';
}

function fullLabel(option: WorkspaceContext) {
  return option.accountName ? `${shortLabel(option)} · ${option.accountName}` : shortLabel(option);
}
