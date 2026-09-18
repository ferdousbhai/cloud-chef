import { useStore } from '@nanostores/react';
import { lazy, Suspense, useState } from 'react';
import { chatStore } from '~/lib/stores/chatId';
import { ChatDescription } from '~/components/header/ChatDescription.client';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { HamburgerMenuIcon, PersonIcon, GearIcon, ExitIcon } from '@radix-ui/react-icons';
import { profileStore, setProfile } from '~/lib/stores/profile';
import { Menu as MenuComponent, MenuItem as MenuItemComponent } from '@ui/Menu';
import { signOutOfCloudChef } from '~/lib/auth-client';
import { BrandLink } from '~/components/BrandLink';
import { Button } from '@ui/Button';
import { ThemeSwitch } from '~/components/ui/ThemeSwitch';
import { toast } from 'sonner';
import { LinkButton } from '~/components/ui/LinkButton';
import { useNavigate } from '@tanstack/react-router';
import { classNames } from '~/utils/classNames';

const DownloadButton = lazy(() => import('./DownloadButton').then((module) => ({ default: module.DownloadButton })));
const MobileProjectMenuItems = lazy(() =>
  import('./DownloadButton').then((module) => ({ default: module.MobileProjectMenuItems })),
);
const SidebarMenu = lazy(() => import('~/components/sidebar/Menu.client').then((module) => ({ default: module.Menu })));
const HeaderActionButtons = lazy(() =>
  import('./HeaderActionButtons.client').then((module) => ({ default: module.HeaderActionButtons })),
);

export function Header({ hideSidebarIcon = false }: { hideSidebarIcon?: boolean }) {
  const chat = useStore(chatStore);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const navigate = useNavigate();

  const userId = useUserIdOrNullOrLoading();
  const isAuthenticated = userId !== null && userId !== undefined;
  const showSidebarIcon = !hideSidebarIcon && isAuthenticated;

  const profile = useStore(profileStore);

  const handleLogout = async () => {
    try {
      await signOutOfCloudChef();
      setProfile(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to sign out. Please try again.');
    }
  };

  const handleSettingsClick = () => void navigate({ to: '/settings' });

  return (
    <>
      <header
        className={classNames(
          'cloudchef-header flex h-[var(--header-height)] items-center overflow-x-auto overflow-y-hidden border-b px-3 sm:px-5',
          { 'py-1 lg:py-3': chat.started, 'py-1.5 sm:py-3': !chat.started },
        )}
        data-chat-started={chat.started}
      >
        <div className="z-40 flex shrink-0 items-center gap-3 text-content-primary">
          {showSidebarIcon && (
            <button
              type="button"
              className="cloudchef-header__menu-button !size-11 sm:!size-9"
              data-hamburger-menu
              aria-label={isMenuOpen ? 'Close project menu' : 'Open project menu'}
              aria-expanded={isMenuOpen}
              aria-controls="project-sidebar"
              onClick={(e) => {
                e.stopPropagation();
                setIsMenuOpen((open) => !open);
              }}
            >
              <HamburgerMenuIcon aria-hidden />
            </button>
          )}
          <BrandLink
            variant="header"
            className={classNames(
              'flex items-center gap-2 rounded-md text-content-primary no-underline hover:text-content-primary hover:no-underline',
              { 'max-[479px]:hidden': showSidebarIcon && chat.started },
            )}
            nameClassName="cloudchef-brand-name font-display text-lg font-black leading-none text-content-primary"
          />
        </div>
        {chat.started && (
          <div className="hidden min-w-0 flex-1 px-4 text-center text-content-primary lg:block">
            <ChatDescription />
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {chat.started && (
            <>
              <Suspense fallback={null}>
                <div className="hidden lg:block">
                  <DownloadButton />
                </div>
              </Suspense>
              <Suspense fallback={null}>
                <div className="mr-1">
                  <HeaderActionButtons />
                </div>
              </Suspense>
            </>
          )}
          <ThemeSwitch
            className={chat.started ? 'hidden lg:inline-flex' : '!size-11 !min-h-11 sm:!size-auto sm:!min-h-9'}
          />
          {profile && (
            <>
              <div className="hidden items-center gap-1 lg:flex">
                <LinkButton variant="ghost" size="xs" to="/settings" icon={<GearIcon />}>
                  Settings
                </LinkButton>
                <Button variant="ghost" size="xs" onClick={() => void handleLogout()} icon={<ExitIcon />}>
                  Log out
                </Button>
              </div>
              <div className="lg:hidden">
                <MenuComponent
                  buttonProps={{
                    variant: 'neutral',
                    title: 'User menu',
                    inline: true,
                    className: '!size-11 !min-h-11 rounded !p-1.5',
                    icon: <ProfileAvatar avatar={profile.avatar} username={profile.username} />,
                  }}
                >
                  {chat.started && (
                    <Suspense fallback={null}>
                      <MobileProjectMenuItems />
                    </Suspense>
                  )}
                  <MenuItemComponent action={handleSettingsClick}>
                    <GearIcon className="text-content-secondary" />
                    Settings
                  </MenuItemComponent>
                  <MenuItemComponent action={() => void handleLogout()}>
                    <ExitIcon className="text-content-secondary" />
                    Log out
                  </MenuItemComponent>
                </MenuComponent>
              </div>
            </>
          )}
        </div>
      </header>
      {isMenuOpen && (
        <Suspense fallback={null}>
          <SidebarMenu isOpen onClose={() => setIsMenuOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

function ProfileAvatar({ avatar, username }: { avatar?: string | null; username?: string | null }) {
  return avatar ? (
    <img
      src={avatar}
      alt={username ? `${username} profile` : 'User profile'}
      className="size-8 min-w-8 rounded object-cover"
      loading="eager"
      decoding="sync"
    />
  ) : (
    <PersonIcon className="size-8 min-w-8 rounded border text-content-secondary" />
  );
}
