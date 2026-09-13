import { createClientOnlyFn } from '@tanstack/react-start';
import { ClientOnly } from '@tanstack/react-router';
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { BrandLink } from '~/components/BrandLink';
import { HomeHeroCopy } from '~/components/HomeHeroCopy';
import { Loading } from '~/components/Loading';

type EmptyProps = Record<string, never>;

function createClientComponent<TProps extends object>(
  getComponent: () => ComponentType<TProps>,
  renderFallback: (props: TProps) => ReactNode = () => null,
) {
  function HydratedClientComponent(props: TProps) {
    const Component = getComponent();
    const fallback = renderFallback(props);
    return (
      <Suspense fallback={fallback}>
        <Component {...props} />
      </Suspense>
    );
  }

  return function ClientComponent(props: TProps) {
    const fallback = renderFallback(props);
    return (
      <ClientOnly fallback={fallback}>
        <HydratedClientComponent {...props} />
      </ClientOnly>
    );
  };
}

const LazyHeader = lazy(() => import('~/components/header/Header.client').then((mod) => ({ default: mod.Header })));
const LazyHomepage = lazy(() => import('~/components/Homepage.client').then((mod) => ({ default: mod.Homepage })));
const LazyExistingChat = lazy(() =>
  import('~/components/ExistingChat.client').then((mod) => ({ default: mod.ExistingChat })),
);
const LazySettingsContent = lazy(() =>
  import('~/components/SettingsContent.client').then((mod) => ({ default: mod.SettingsContent })),
);
const LazyTelemetryPreference = lazy(() =>
  import('~/components/trust/TelemetryPreference.client').then((mod) => ({ default: mod.TelemetryPreference })),
);

const getClientHeader = createClientOnlyFn(() => LazyHeader);
const getClientHomepage = createClientOnlyFn(() => LazyHomepage);
const getClientExistingChat = createClientOnlyFn(() => LazyExistingChat);
const getClientSettingsContent = createClientOnlyFn(() => LazySettingsContent);
const getClientTelemetryPreference = createClientOnlyFn(() => LazyTelemetryPreference);

export const ClientHeader = createClientComponent<{ hideSidebarIcon?: boolean }>(getClientHeader, () => (
  <HeaderLoadingFallback />
));

export const ClientHomepage = createClientComponent<{ initialId: string }>(getClientHomepage, () => (
  <HomepageLoadingFallback />
));

export const ClientExistingChat = createClientComponent<{ chatId: string }>(getClientExistingChat, () => (
  <Loading message="Loading project…" />
));

export const ClientSettingsContent = createClientComponent<{ authorizationError?: string | null }>(
  getClientSettingsContent,
  () => <Loading message="Loading settings…" />,
);
export const ClientTelemetryPreference = createClientComponent<EmptyProps>(getClientTelemetryPreference);

function HeaderLoadingFallback() {
  return (
    <header className="ghostbuild-header flex h-[var(--header-height)] items-center border-b px-3 py-1.5 sm:px-5 sm:py-3">
      <BrandLink
        variant="header"
        className="flex items-center gap-2 rounded-md text-content-primary no-underline"
        nameClassName="ghostbuild-brand-name font-display text-lg font-black leading-none text-content-primary"
      />
      <span className="sr-only" role="status">
        Loading navigation…
      </span>
    </header>
  );
}

function HomepageLoadingFallback() {
  return (
    <div className="ghost-home-shell grow p-4 sm:px-6 lg:px-8 lg:py-5">
      <section className="ghost-home-copy min-w-0" aria-labelledby="loading-intro">
        <HomeHeroCopy headingId="loading-intro" />
        <div
          className="ghost-message-input--home mt-7 flex min-h-16 items-center px-5 text-sm text-content-secondary"
          role="status"
          aria-live="polite"
        >
          Loading the prompt editor…
        </div>
      </section>
    </div>
  );
}
