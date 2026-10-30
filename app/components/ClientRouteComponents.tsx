import { createClientOnlyFn } from '@tanstack/react-start';
import { ClientOnly } from '@tanstack/react-router';
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { BrandLink } from '~/components/BrandLink';
import { holdEarlyPrompt, PROMPT_TEXTAREA_CLASS } from '~/components/chat/early-prompt';
import { HomeHeroCopy } from '~/components/HomeHeroCopy';
import { Loading } from '~/components/Loading';

type EmptyProps = Record<string, never>;

/** A client-only component, showing `fallback` on the server and while its code loads. */
function createClientComponent<TProps extends object>(getComponent: () => ComponentType<TProps>, fallback: ReactNode) {
  function HydratedClientComponent(props: TProps) {
    // The same module-level lazy component on every call (see the Lazy* constants below): nothing is made here.
    const Component = getComponent();
    return (
      <Suspense fallback={fallback}>
        {/* oxlint-disable-next-line react/static-components */}
        <Component {...props} />
      </Suspense>
    );
  }

  return function ClientComponent(props: TProps) {
    return (
      <ClientOnly fallback={fallback}>
        <HydratedClientComponent {...props} />
      </ClientOnly>
    );
  };
}

const LazyHeader = lazy(() => import('~/components/header/Header').then((mod) => ({ default: mod.Header })));
const LazyHomepage = lazy(() => import('~/components/Homepage.client').then((mod) => ({ default: mod.Homepage })));
const LazyExistingChat = lazy(() =>
  import('~/components/ExistingChat.client').then((mod) => ({ default: mod.ExistingChat })),
);
const LazySettingsContent = lazy(() =>
  import('~/components/SettingsContent.client').then((mod) => ({ default: mod.SettingsContent })),
);
const LazyFeed = lazy(() => import('~/components/showcase/Feed.client').then((mod) => ({ default: mod.Feed })));
const LazyNotifications = lazy(() =>
  import('~/components/showcase/Notifications.client').then((mod) => ({ default: mod.Notifications })),
);
const LazyReports = lazy(() =>
  import('~/components/showcase/Reports.client').then((mod) => ({ default: mod.Reports })),
);
const LazyApprovals = lazy(() =>
  import('~/components/approvals/Approvals.client').then((mod) => ({ default: mod.Approvals })),
);
const LazyTelemetryPreference = lazy(() =>
  import('~/components/trust/TelemetryPreference.client').then((mod) => ({ default: mod.TelemetryPreference })),
);

const getClientHeader = createClientOnlyFn(() => LazyHeader);
const getClientHomepage = createClientOnlyFn(() => LazyHomepage);
const getClientExistingChat = createClientOnlyFn(() => LazyExistingChat);
const getClientSettingsContent = createClientOnlyFn(() => LazySettingsContent);
const getClientFeed = createClientOnlyFn(() => LazyFeed);
const getClientNotifications = createClientOnlyFn(() => LazyNotifications);
const getClientReports = createClientOnlyFn(() => LazyReports);
const getClientApprovals = createClientOnlyFn(() => LazyApprovals);
const getClientTelemetryPreference = createClientOnlyFn(() => LazyTelemetryPreference);

export const ClientHeader = createClientComponent<EmptyProps>(getClientHeader, <HeaderLoadingFallback />);

export const ClientHomepage = createClientComponent<{ initialId: string }>(
  getClientHomepage,
  <HomepageLoadingFallback />,
);

export const ClientExistingChat = createClientComponent<{ workspaceId: string }>(
  getClientExistingChat,
  <Loading message="Loading project…" />,
);

export const ClientSettingsContent = createClientComponent<{ authorizationError?: string | null }>(
  getClientSettingsContent,
  <Loading message="Loading settings…" />,
);
export const ClientFeed = createClientComponent<EmptyProps>(getClientFeed, <Loading message="Loading your feed…" />);
export const ClientNotifications = createClientComponent<EmptyProps>(
  getClientNotifications,
  <Loading message="Loading notifications…" />,
);
export const ClientReports = createClientComponent<EmptyProps>(
  getClientReports,
  <Loading message="Loading reports…" />,
);
export const ClientApprovals = createClientComponent<EmptyProps>(
  getClientApprovals,
  <Loading message="Loading approvals…" />,
);
export const ClientTelemetryPreference = createClientComponent<EmptyProps>(getClientTelemetryPreference, null);

function HeaderLoadingFallback() {
  return (
    <header className="cloudchef-header flex h-(--header-height) items-center border-b px-3 py-1.5 sm:px-5 sm:py-3">
      <BrandLink
        variant="header"
        className="flex items-center gap-2 rounded-md text-content-primary no-underline"
        nameClassName="cloudchef-brand-name font-display text-lg font-bold leading-none text-content-primary"
      />
      <span className="sr-only" role="status">
        Loading navigation…
      </span>
    </header>
  );
}

/**
 * The home as it first paints: the same shell, heading and prompt box as `HomeIntro`, box for box, so nothing
 * moves when the real editor replaces it. The box takes typing at once and hands it to the real editor.
 */
function HomepageLoadingFallback() {
  return (
    <div className="cloudchef-home-shell grow p-4 sm:px-6 lg:px-8">
      <section className="cloudchef-home-copy min-w-0" aria-labelledby="loading-intro">
        <div className="cloudchef-home-hero">
          <div className="min-w-0">
            <HomeHeroCopy headingId="loading-intro" />
            <div className="cloudchef-home-composer-stack">
              <div className="cloudchef-message-input--home relative z-20 mx-auto w-full max-w-none">
                <div className="cloudchef-message-input__surface rounded-lg bg-bolt-elements-background-depth-1 p-2 shadow-panel">
                  <div className="cloudchef-message-input__editor relative border border-bolt-elements-borderColor">
                    <div className="relative overflow-y-hidden" style={{ minHeight: 44, maxHeight: 160 }}>
                      <textarea
                        ref={holdEarlyPrompt}
                        rows={1}
                        className={PROMPT_TEXTAREA_CLASS}
                        style={{ minHeight: 44 }}
                        placeholder="Describe your app…"
                        aria-label="Message to CloudChef"
                        translate="no"
                        data-gramm="false"
                      />
                    </div>
                    <div className="cloudchef-message-input__toolbar flex items-center px-2 pb-2">
                      <span className="sr-only" role="status">
                        Loading the prompt editor…
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
