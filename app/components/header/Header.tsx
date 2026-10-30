import { useStore } from '@nanostores/react';
import { lazy, Suspense, useState } from 'react';
import { chatStore } from '~/lib/stores/workspaceId';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { BellIcon, ExitIcon, GearIcon, HamburgerMenuIcon, PersonIcon } from '@radix-ui/react-icons';
import { useWaitingApprovals } from '~/lib/cloudflare/approvals.client';
import { Menu as MenuComponent, MenuItem as MenuItemComponent, MenuSeparator } from '@ui/Menu';
import { authClient } from '~/lib/auth-client';
import { logOut } from '~/lib/account-actions.client';
import { BrandLink } from '~/components/BrandLink';
import { useNavigate } from '@tanstack/react-router';
import { classNames } from '~/utils/classNames';
import { ChooseUsernamePrompt } from '~/components/settings/UsernameForm.client';
import { useWebMcpTools } from '~/lib/webmcp.client';
import { useUnreadNotifications } from '~/lib/showcase-api';

const ProjectMenu = lazy(() => import('./ProjectMenu.client').then((module) => ({ default: module.ProjectMenu })));
const ProjectDialogs = lazy(() =>
  import('./ProjectDialogs.client').then((module) => ({ default: module.ProjectDialogs })),
);
const SidebarMenu = lazy(() => import('~/components/sidebar/Menu.client').then((module) => ({ default: module.Menu })));
const HeaderActionButtons = lazy(() =>
  import('./HeaderActionButtons.client').then((module) => ({ default: module.HeaderActionButtons })),
);
const WaitingCopies = lazy(() =>
  import('~/components/showcase/WaitingCopies.client').then((module) => ({ default: module.WaitingCopies })),
);

export function Header() {
  const chat = useStore(chatStore);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const navigate = useNavigate();

  const userId = useUserIdOrNullOrLoading();
  const isAuthenticated = userId !== null && userId !== undefined;
  const showSidebarIcon = isAuthenticated;

  const session = authClient.useSession().data;
  const user = session?.user ?? null;
  const teamAdmin =
    session?.contexts.some((context) => context.kind === 'organization' && context.role === 'admin') ?? false;
  // Approvals are in the sidebar; while some wait, its button says so.
  const waitingApprovals = useWaitingApprovals(teamAdmin);
  // An agent in the browser gets a few of CloudChef's actions as tools, while someone is signed in to build.
  const context = session?.context ?? null;
  useWebMcpTools(
    context
      ? {
          account: context.kind === 'organization' ? context.orgName : 'Personal',
          mayStartProjects: context.kind !== 'organization' || context.draftsAllowed,
        }
      : null,
  );
  const menuLabel = isMenuOpen ? 'Close project menu' : 'Open project menu';
  // Someone followed, liked, commented on or copied their work: a dot on their avatar until they look.
  const unread = useUnreadNotifications(user !== null);
  const username = session?.user.username ?? null;

  return (
    <>
      <header
        className="cloudchef-header flex h-(--header-height) items-center overflow-x-auto overflow-y-hidden border-b px-3 py-0.5 sm:px-4"
        data-chat-started={chat.started}
      >
        <div className="z-40 flex shrink-0 items-center gap-3 text-content-primary">
          {showSidebarIcon && (
            <button
              type="button"
              className="cloudchef-header__menu-button relative size-11! sm:size-9!"
              data-hamburger-menu
              aria-label={waitingApprovals > 0 ? `${menuLabel} (${waitingApprovals} waiting for approval)` : menuLabel}
              aria-expanded={isMenuOpen}
              aria-controls="project-sidebar"
              onClick={(e) => {
                e.stopPropagation();
                setIsMenuOpen((open) => !open);
              }}
            >
              <HamburgerMenuIcon aria-hidden />
              {waitingApprovals > 0 ? (
                <span aria-hidden className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent-500" />
              ) : null}
            </button>
          )}
          <BrandLink
            variant="header"
            className={classNames(
              'flex items-center gap-2 rounded-md text-content-primary no-underline hover:text-content-primary hover:no-underline',
              { 'max-[479px]:hidden': showSidebarIcon && chat.started },
            )}
            nameClassName="cloudchef-brand-name font-display text-lg font-bold leading-none text-content-primary"
          />
        </div>
        <div className="flex min-w-0 flex-1 px-2 sm:px-4">
          {chat.started && (
            <Suspense fallback={null}>
              <ProjectMenu />
            </Suspense>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Suspense fallback={null}>
            <HeaderActionButtons />
          </Suspense>
          {user && (
            <MenuComponent
              buttonProps={{
                variant: 'neutral',
                title: unread > 0 ? `Account (${unread} new notifications)` : 'Account',
                inline: true,
                className: 'relative !size-11 !min-h-11 sm:!size-9 sm:!min-h-9 rounded !p-1',
                icon: (
                  <>
                    <ProfileAvatar avatar={user.image} username={user.name} />
                    {unread > 0 ? (
                      <span
                        aria-hidden
                        className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-[rgb(225,48,88)] ring-2 ring-(--cc-background-primary)"
                      />
                    ) : null}
                  </>
                ),
              }}
            >
              <div className="px-3 py-2 text-xs text-content-secondary">
                <div className="truncate font-semibold text-content-primary">{user.name}</div>
                <div className="truncate">{user.email}</div>
              </div>
              <MenuSeparator />
              {username ? (
                <MenuItemComponent action={() => void navigate({ to: '/$username', params: { username } })}>
                  <PersonIcon className="text-content-secondary" />
                  Your page
                </MenuItemComponent>
              ) : null}
              <MenuItemComponent action={() => void navigate({ to: '/notifications' })}>
                <BellIcon className="text-content-secondary" />
                {unread > 0 ? `Notifications (${unread})` : 'Notifications'}
              </MenuItemComponent>
              <MenuItemComponent action={() => void navigate({ to: '/settings' })}>
                <GearIcon className="text-content-secondary" />
                Settings
              </MenuItemComponent>
              <MenuItemComponent action={() => void logOut()}>
                <ExitIcon className="text-content-secondary" />
                Log out
              </MenuItemComponent>
            </MenuComponent>
          )}
        </div>
      </header>
      {chat.started && (
        <Suspense fallback={null}>
          <ProjectDialogs />
        </Suspense>
      )}
      {isMenuOpen && (
        <Suspense fallback={null}>
          <SidebarMenu isOpen waitingApprovals={waitingApprovals} onClose={() => setIsMenuOpen(false)} />
        </Suspense>
      )}
      {isAuthenticated && <ChooseUsernamePrompt />}
      {session?.context ? (
        <Suspense fallback={null}>
          <WaitingCopies />
        </Suspense>
      ) : null}
    </>
  );
}

function ProfileAvatar({ avatar, username }: { avatar?: string | null; username?: string | null }) {
  return avatar ? (
    <img
      src={avatar}
      alt={username ? `${username} profile` : 'User profile'}
      className="size-full rounded object-cover"
      loading="eager"
      decoding="sync"
    />
  ) : (
    <PersonIcon className="size-5 text-content-secondary" />
  );
}
