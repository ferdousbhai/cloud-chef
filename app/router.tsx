import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { contentSecurityPolicyNonce } from './lib/csp-nonce';

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    ssr: { nonce: contentSecurityPolicyNonce() },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  });
}

/**
 * The router type registration that is actually in effect.
 *
 * `app/routeTree.gen.ts` ends with a similar-looking block the TanStack Start vite plugin appends,
 * but that one is inert: it writes `declare module '@tanstack/react-start'`, and
 * `@tanstack/react-start` declares no `Register` at all, so it only ever mints a fresh interface
 * nobody reads. `Register` is declared once, in `@tanstack/router-core`, and is reached through the
 * `@tanstack/react-router` re-export augmented here — so this is the only place a registration can
 * take hold. Do not read the generated block as a second copy of this one.
 *
 * `ssr: true` is load-bearing rather than decorative. `RegisteredSsr` gates
 * `ValidateSerializableLifecycleResult`, which short-circuits to `any` while SSR is unregistered:
 * without it TypeScript never checks that a route loader returns something that can survive the SSR
 * serialization boundary, and a value that cannot only fails at runtime, during render.
 */
declare module '@tanstack/react-router' {
  interface Register {
    ssr: true;
    router: ReturnType<typeof getRouter>;
  }
}
