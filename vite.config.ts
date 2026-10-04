import { cloudflare } from '@cloudflare/vite-plugin';
import agents from 'agents/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import wasm from 'vite-plugin-wasm';
import { fileURLToPath } from 'node:url';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig((config) => {
  const isTest = config.mode === 'test';

  return {
    build: {
      target: 'esnext',
      // Worker source maps are uploaded privately by `cf deploy`; source maps can include backend code, so secrets
      // must never be hardcoded. The client environment below turns them off so no map ships as a public asset.
      sourcemap: true,
      rolldownOptions: {
        output: {
          format: 'esm',
        },
      },
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
    environments: {
      client: {
        build: {
          sourcemap: false,
        },
      },
    },
    optimizeDeps: {
      include: ['react-dom'],
    },
    define: {
      global: 'globalThis',
    },
    resolve: {
      tsconfigPaths: true,
      alias: isTest ? { 'cloudflare:workers': fromRoot('./app/test/cloudflare-workers-shim.ts') } : undefined,
    },
    ssr: {
      noExternal: isTest
        ? ['@cloudflare/computer', '@cloudflare/sandbox', '@cloudflare/containers', 'agents']
        : undefined,
    },
    test: {
      exclude: [...configDefaults.exclude, 'e2e/**'],
    },
    plugins: [
      !isTest && agents(),
      !isTest && cloudflare({ viteEnvironment: { name: 'ssr' } }),
      // This plugin's codegen is the only writer of `app/routeTree.gen.ts`. Its route-tree hook
      // runs on vite's `configResolved`, so `scripts/generate-route-tree.mjs` can refresh the tree
      // outside a build by resolving this very config — see that script.
      !isTest &&
        tanstackStart({
          srcDirectory: 'app',
          router: {
            routesDirectory: 'routes',
            generatedRouteTree: 'routeTree.gen.ts',
            quoteStyle: 'single',
            semicolons: true,
          },
        }),
      react(),
      config.mode === 'production' && optimizeCssModules({ apply: 'build' }),
      wasm(),
    ].filter(Boolean),
    envPrefix: ['VITE_'],
  };
});
