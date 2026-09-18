import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const rootDirectory = dirname(fileURLToPath(import.meta.url));
const fromRoot = (path: string) => resolve(rootDirectory, path);

const testSecrets = {
  CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-key',
  CLOUDFLARE_OAUTH_CLIENT_SECRET: 'test-oauth-secret',
};

for (const [name, value] of Object.entries(testSecrets)) {
  process.env[name] = value;
}

const serverDependencyStubs = new Set([
  './lib/cloudflare/data/cloudflare-auth-retention.server',
  './server-handlers/auth',
  './server-handlers/cloudflare-integration',
]);

function isolateRootWorkerRoutes(): Plugin {
  const stub = fromRoot('./tests/workerd/server-dependencies.stub.ts');
  return {
    name: 'cloudchef-workerd-route-boundaries',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@tanstack/react-start/server-entry') {
        return stub;
      }
      const importerPath = importer?.replace(/\?.*$/, '');
      if (importerPath?.endsWith('/app/server.ts') && serverDependencyStubs.has(source)) {
        return stub;
      }
    },
  };
}

export default defineConfig({
  plugins: [
    isolateRootWorkerRoutes(),
    tanstackStart({
      srcDirectory: 'app',
      router: {
        routesDirectory: 'routes',
        generatedRouteTree: 'routeTree.gen.ts',
        quoteStyle: 'single',
        semicolons: true,
      },
    }),
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Production secrets are never needed by local integration tests.
          ...testSecrets,
          CLOUDFLARE_OAUTH_CLIENT_ID: 'test-oauth-client',
          TEST_MIGRATIONS: await readD1Migrations(fromRoot('./migrations')),
          COMMIT_SHA: 'workerd-test-sha',
        },
      },
    })),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ['tests/workerd/**/*.integration.ts'],
  },
});
