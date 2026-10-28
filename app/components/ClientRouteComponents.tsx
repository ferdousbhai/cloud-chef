import { createClientOnlyFn } from '@tanstack/react-start';
import { ClientOnly } from '@tanstack/react-router';
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { BrandLink } from '~/components/BrandLink';
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
const LazyExplore = lazy(() =>
  import('~/components/projects/Explore.client').then((mod) => ({ default: mod.Explore })),
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
const getClientExplore = createClientOnlyFn(() => LazyExplore);
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
export const ClientExplore = createClientComponent<EmptyProps>(
  getClientExplore,
  <Loading message="Loading public projects…" />,
);
export const ClientApprovals = createClientComponent<EmptyProps>(
  getClientApprovals,
  <Loading message="Loading approvals…" />,
);
export const ClientTelemetryPreference = createClientComponent<EmptyProps>(getClientTelemetryPreference, null);

function HeaderLoadingFallback() {
  return (
    <header className="cloudchef-header flex h-[var(--header-height)] items-center border-b px-3 py-1.5 sm:px-5 sm:py-3">
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

function HomepageLoadingFallback() {
  return (
    <div className="cloudchef-home-shell grow p-4 sm:px-6 lg:px-8 lg:py-5">
      <section className="cloudchef-home-copy min-w-0" aria-labelledby="loading-intro">
        <HomeHeroCopy headingId="loading-intro" />
        <div
          className="cloudchef-message-input--home mt-7 flex min-h-16 items-center px-5 text-sm text-content-secondary"
          role="status"
          aria-live="polite"
        >
          Loading the prompt editor…
        </div>
      </section>
    </div>
  );
}
