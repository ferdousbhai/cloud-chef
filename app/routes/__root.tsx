import { useStore } from '@nanostores/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { ErrorDisplay } from '~/components/ErrorComponent';
import { BrandLink } from '~/components/BrandLink';
import { LinkButton } from '~/components/ui/LinkButton';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { themeStore } from '~/lib/stores/theme';
import { stripIndents } from 'cloudchef-agent/utils/stripIndent';
import globalStyles from '~/styles/index.css?url';
import latinMonoFont from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';

type RootSearch = {
  prefill?: string;
};

const inlineBootstrapCode = stripIndents`
  setCloudChefTheme();
  installAssetLoadRecovery();

  function setCloudChefTheme() {
    let theme = null;

    try {
      theme = localStorage.getItem('cloudchef_theme');
    } catch (storageUnavailable) {
      // Storage can be unavailable in privacy-restricted browser contexts; fall back to the media query.
    }

    if (!theme) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    document.documentElement.setAttribute('class', theme);
  }

  function installAssetLoadRecovery() {
    var recoveryKey = 'cloudchef:asset-load-recovery';
    window.setTimeout(function clearAssetLoadRecovery() {
      try {
        sessionStorage.removeItem(recoveryKey);
      } catch (storageUnavailable) {
        // Storage can be unavailable in privacy-restricted browser contexts.
      }
    }, 30000);
    window.addEventListener('error', function recoverAssetLoad(event) {
      var target = event.target;
      var source = target instanceof HTMLScriptElement
        ? target.src
        : target instanceof HTMLLinkElement
          ? target.href
          : '';
      if (!source.includes('/assets/')) {
        return;
      }
      var attempts;
      try {
        attempts = Number(sessionStorage.getItem(recoveryKey) || '0');
      } catch (storageUnavailable) {
        // Without storage the retry count cannot be bounded, so do not reload at all.
        return;
      }
      if (!Number.isFinite(attempts) || attempts >= 3) {
        return;
      }
      attempts += 1;
      try {
        sessionStorage.setItem(recoveryKey, String(attempts));
      } catch (storageUnavailable) {
        return;
      }
      window.setTimeout(function reloadForCurrentAssets() {
        window.location.reload();
      }, attempts * 500);
    }, true);
  }
`;

const dynamicImportRecoveryKey = 'cloudchef:dynamic-import-recovery';

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): RootSearch =>
    typeof search.prefill === 'string' ? { prefill: search.prefill } : {},
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'CloudChef' },
      {
        name: 'description',
        content: 'Build and ship Cloudflare apps with CloudChef, the full-stack AI coding agent.',
      },
      { name: 'application-name', content: 'CloudChef' },
      { name: 'color-scheme', content: 'light dark' },
      { name: 'theme-color', content: '#1a1b26' },
    ],
    links: [
      {
        rel: 'icon',
        href: '/cloudchef-logo.svg?v=3',
        type: 'image/svg+xml',
      },
      { rel: 'manifest', href: '/site.webmanifest' },
      // The whole page is set in this face, so discovering it only after the
      // stylesheet parses costs a round trip of full-page fallback text.
      {
        rel: 'preload',
        as: 'font',
        type: 'font/woff2',
        href: latinMonoFont,
        crossOrigin: 'anonymous',
      },
      { rel: 'stylesheet', href: globalStyles },
    ],
    scripts: [{ children: inlineBootstrapCode }],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFoundComponent,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={themeStore.value}>
      <head>
        <HeadContent />
      </head>
      <body>
        <div id="root" className="size-full">
          {children}
        </div>
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

function Layout({ children }: { children: ReactNode }) {
  const theme = useStore(themeStore);

  useEffect(() => {
    document.documentElement.setAttribute('class', theme);
  }, [theme]);

  useDynamicImportRecovery();

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <QueryClientProvider client={queryClient}>
        <main id="main-content" className="size-full">
          {children}
        </main>
      </QueryClientProvider>
    </>
  );
}

function RootNotFoundComponent() {
  return (
    <div className="app-page-shell flex min-h-svh items-center px-4 py-6">
      <section className="app-error-card app-card mx-auto" aria-labelledby="not-found-heading">
        <div className="mb-4 flex items-center justify-between gap-4">
          <BrandLink />
          <span className="app-status-badge">404</span>
        </div>
        <h1 id="not-found-heading" className="app-page-title !text-2xl">
          This page does not exist.
        </h1>
        <div className="mt-4">
          <LinkButton to="/">Back to CloudChef</LinkButton>
        </div>
      </section>
    </div>
  );
}

function RootErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  useEffect(() => {
    recoverFromDynamicImportError(error);
  }, [error]);

  if (typeof window !== 'undefined' && isDynamicImportError(error) && !hasRecoveredDynamicImportForCurrentBuild()) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-content-secondary">Refreshing…</div>
    );
  }

  return <ErrorDisplay error={error} resetErrorBoundary={reset} />;
}

function useDynamicImportRecovery() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      if (recoverFromDynamicImportError(event.error ?? event.message)) {
        event.preventDefault();
      }
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (recoverFromDynamicImportError(event.reason)) {
        event.preventDefault();
      }
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);
}

function recoverFromDynamicImportError(error: unknown) {
  if (typeof window === 'undefined' || !isDynamicImportError(error) || hasRecoveredDynamicImportForCurrentBuild()) {
    return false;
  }

  try {
    window.sessionStorage?.setItem(dynamicImportRecoveryKey, getDynamicImportRecoveryToken());
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts; without a recorded attempt
    // the reload cannot be bounded, so surface the error instead.
    return false;
  }

  window.location.reload();
  return true;
}

function hasRecoveredDynamicImportForCurrentBuild() {
  try {
    return window.sessionStorage?.getItem(dynamicImportRecoveryKey) === getDynamicImportRecoveryToken();
  } catch {
    // Treat an unreadable store as recovery already spent so the page cannot reload forever.
    return true;
  }
}

function getDynamicImportRecoveryToken() {
  const assetScripts = Array.from(document.scripts)
    .map((script) => script.src)
    .filter((src) => src.includes('/assets/'));

  return assetScripts.join('|') || window.location.href;
}

function isDynamicImportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Importing a module script failed')
  );
}
