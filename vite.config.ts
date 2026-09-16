import { cloudflare } from '@cloudflare/vite-plugin';
import agents from 'agents/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import wasm from 'vite-plugin-wasm';
import { fileURLToPath } from 'node:url';
import { readFile, rm, writeFile } from 'node:fs/promises';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const CLIENT_ASSETS_IGNORE_PATH = fromRoot('./dist/client/.assetsignore');

function withPrivateClientSourceMaps(content: string): string {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (!lines.includes('*.map')) {
    lines.push('*.map');
  }
  return `${lines.join('\n')}\n`;
}

export default defineConfig((config) => {
  const isTest = config.mode === 'test';

  return {
    build: {
      target: 'esnext',
      // Source maps can include backend code, so secrets must never be hardcoded.
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
      {
        name: 'ghostbuild-strip-local-dev-vars',
        apply: 'build',
        async closeBundle() {
          await rm(fromRoot('./dist/server/.dev.vars'), { force: true });
        },
      },
      !isTest && cloudflare({ viteEnvironment: { name: 'ssr' } }),
      {
        name: 'ghostbuild-private-client-source-maps',
        apply: 'build',
        enforce: 'post',
        async closeBundle() {
          const generatedIgnore = await readFile(CLIENT_ASSETS_IGNORE_PATH, 'utf8');
          await writeFile(CLIENT_ASSETS_IGNORE_PATH, withPrivateClientSourceMaps(generatedIgnore));
        },
      },
      // This plugin's codegen also writes `app/routeTree.gen.ts`, and it always appends a
      // `declare module '@tanstack/react-start'` footer that it builds itself — there is no option
      // to suppress it (`router.routeTreeFileFooter` only appends *after* it). `tsr generate`, the
      // other writer of that file, knows nothing about Start and would otherwise strip the footer
      // on every run, so `tsr.config.json` mirrors it verbatim under `routeTreeFileFooter`. Keep
      // the two in sync: if a TanStack upgrade changes the footer, the committed route tree starts
      // flip-flopping again and `validate` fails on a dirty tree.
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
