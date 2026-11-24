import { CheckIcon, ChevronDownIcon, PlusIcon } from '@radix-ui/react-icons';
import { useNavigate } from '@tanstack/react-router';
import { Menu, MenuItem } from '@ui/Menu';
import { authClient } from '~/lib/auth-client';
import { switchAccount } from '~/lib/account-actions.client';
import type { WorkspaceContext } from '~/lib/.server/auth';
import { workspaceName } from '~/lib/workspace-name';

/**
 * Which Cloudflare account the builder works in: the person's own, or an organization's they belong
 * to. Beside the logo, since it decides which projects are listed; it lists every account to switch to, and
 * leads to creating and managing organizations.
 */
export function WorkspaceSwitcher({ className, align }: { className?: string; align?: 'start' | 'end' }) {
  const { data: session } = authClient.useSession();
  if (!session) {
    return null;
  }
  const current = session.context;
  return (
    <Menu
      align={align}
      buttonProps={{
        variant: 'neutral',
        size: 'xs',
        className,
        // The button names the workspace briefly; its Cloudflare account is in the tooltip and the menu.
        title: current ? `${fullLabel(current, session.contexts)}. Switch account or manage teams` : 'Manage teams',
        children: (
          <>
            <span className="min-w-0 truncate">
              {current ? workspaceName(current, session.contexts) : 'No workspace'}
            </span>
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
            <span className="wrap-break-word">{workspaceName(option, session.contexts)}</span>
            {option.accountName ? (
              <span className="wrap-break-word text-xs text-content-tertiary">{option.accountName}</span>
            ) : null}
          </span>
        </MenuItem>
      ))}
      <MenuItem action={organizations}>
        <PlusIcon aria-hidden />
        {/* The session lists only teams with a connected account, so a member of one still unconnected sees Teams too. */}
        {/* A space with only its subscriber in it is their own account, not a team to manage. */}
        {session.contexts.some((option) => !option.solo) ? 'Manage spaces' : 'Spaces'}
      </MenuItem>
    </>
  );
}

function fullLabel(option: WorkspaceContext, all: readonly WorkspaceContext[]) {
  const name = workspaceName(option, all);
  return option.accountName ? `${name} · ${option.accountName}` : name;
}
