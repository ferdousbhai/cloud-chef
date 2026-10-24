import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { ArrowLeftIcon, AvatarIcon, IdCardIcon, LockClosedIcon, MagicWandIcon } from '@radix-ui/react-icons';
import { ProfileCard } from '~/components/settings/ProfileCard';
import { Toaster } from '~/components/ui/Toaster';
import { LinkButton } from '~/components/ui/LinkButton';
import { BrandLink } from '~/components/BrandLink';
import { CloudflareCard } from '~/components/settings/CloudflareCard.client';
import { AccountDataCard } from '~/components/settings/AccountDataCard.client';
import { AiRequestLogsCard } from '~/components/settings/AiRequestLogsCard.client';
import { ModelsCard } from '~/components/settings/ModelsCard.client';
import { OrganizationsCard } from '~/components/settings/OrganizationsCard.client';
import { TrustFooter } from '~/components/trust/TrustLinks';
import { classNames } from '~/utils/classNames';

type Tab = 'account' | 'teams' | 'models' | 'data';

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'account', label: 'Account', icon: <IdCardIcon aria-hidden /> },
  { id: 'teams', label: 'Teams', icon: <AvatarIcon aria-hidden /> },
  { id: 'models', label: 'Models', icon: <MagicWandIcon aria-hidden /> },
  { id: 'data', label: 'Privacy & data', icon: <LockClosedIcon aria-hidden /> },
];

/** The tab a link into Settings names, by its tab or by a card's id (links made before the tabs). */
const TAB_FOR_HASH = {
  account: 'account',
  profile: 'account',
  cloudflare: 'account',
  teams: 'teams',
  organizations: 'teams',
  models: 'models',
  data: 'data',
  'your-data': 'data',
  'ai-request-logs': 'data',
} satisfies Record<string, Tab>;

/** The tab the address names; Settings renders in the browser only, so the address is there. */
function tabFromLocation(): Tab | null {
  const hash = window.location.hash.replace(/^#/, '');
  const hashTab = Object.entries(TAB_FOR_HASH).find(([linked]) => linked === hash)?.[1];
  if (hashTab) {
    return hashTab;
  }
  // A return from GitHub has something to say about a team.
  return new URL(window.location.href).searchParams.has('github_message') ? 'teams' : null;
}

export function SettingsContent({ authorizationError }: { authorizationError?: string | null }) {
  const [tab, setTab] = useState<Tab>(() => tabFromLocation() ?? 'account');
  const routerHash = useRouterState({ select: (state) => state.location.hash });
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());

  // A link followed while Settings is open (the model picker's, a team deleted) picks its tab.
  useEffect(() => {
    const follow = () => {
      const linked = tabFromLocation();
      if (linked) {
        setTab(linked);
      }
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [routerHash]);

  const choose = (next: Tab, focus = false) => {
    setTab(next);
    // The address names the tab, so a reload or a shared link opens it again.
    const url = new URL(window.location.href);
    url.hash = next;
    window.history.replaceState(window.history.state, '', url);
    if (focus) {
      tabRefs.current.get(next)?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const index = TABS.findIndex(({ id }) => id === tab);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TABS.length - 1
          : step
            ? (index + step + TABS.length) % TABS.length
            : null;
    if (target !== null) {
      event.preventDefault();
      choose(TABS[target].id, true);
    }
  };

  const panel = (id: Tab, children: ReactNode) => (
    <div
      id={`settings-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`settings-tab-${id}`}
      hidden={tab !== id}
      className={tab === id ? 'grid min-w-0 content-start gap-3' : undefined}
    >
      {children}
    </div>
  );

  return (
    <div className="app-page-shell">
      <div className="app-page-container settings-container">
        <nav className="app-page-nav !mb-6" aria-label="Settings navigation">
          <BrandLink />
          <LinkButton to="/" variant="neutral" size="sm" icon={<ArrowLeftIcon aria-hidden />}>
            <span>
              <span className="hidden sm:inline">Back to </span>builder
            </span>
          </LinkButton>
        </nav>

        <div className="settings-layout">
          <div className="settings-sidebar">
            <h1 className="settings-title">Settings</h1>
            <div role="tablist" aria-label="Settings" className="settings-tabs" onKeyDown={onKeyDown}>
              {TABS.map(({ id, label, icon }) => (
                <button
                  key={id}
                  ref={(element) => {
                    if (element) {
                      tabRefs.current.set(id, element);
                    }
                  }}
                  type="button"
                  role="tab"
                  id={`settings-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`settings-panel-${id}`}
                  tabIndex={tab === id ? 0 : -1}
                  className={classNames('settings-tab', tab === id ? 'settings-tab--active' : '')}
                  onClick={() => choose(id)}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-w-0">
            {/* Every panel stays mounted, so each card loads once and a return from Cloudflare or
                GitHub is read whichever tab is open. */}
            {panel(
              'account',
              <>
                <ProfileCard />
                <CloudflareCard initialError={authorizationError} />
              </>,
            )}
            {panel('teams', <OrganizationsCard />)}
            {panel('models', <ModelsCard />)}
            {panel(
              'data',
              <>
                <AiRequestLogsCard />
                <AccountDataCard />
              </>,
            )}
          </div>
        </div>
      </div>
      <TrustFooter className="mt-4" />
      <Toaster />
    </div>
  );
}
