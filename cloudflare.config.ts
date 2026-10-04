import { bindings, defineConfig, exports, triggers } from 'cf/config';

// Deploy tooling injects the environment-specific OAuth client id and commit SHA: scripts/deploy-production.mjs
// and scripts/upload-workers-builds-preview.mjs set both in the environment of the build they then ship, so the
// values reach the Worker as plain-text vars without ever being committed. Absent values are left unbound.
const deployVar = (name: 'COMMIT_SHA' | 'CLOUDFLARE_OAUTH_CLIENT_ID') => {
  const value = process.env[name];
  return value ? { [name]: bindings.text(value) } : {};
};

export default defineConfig({
  worker: {
    name: 'cloudchef',
    compatibilityDate: '2026-07-21',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint: 'app/server.ts',
    workersDev: false,
    previewUrls: true,
    domains: [
      'cloudchef.build',
      'www.cloudchef.build',
      // The retired ghostbuild.dev origin, attached only so the Worker can redirect it to
      // cloudchef.build. Removing these domains strands every link that still points at it.
      'ghostbuild.dev',
      'www.ghostbuild.dev',
    ],
    triggers: [triggers.scheduled({ schedule: '*/15 * * * *' })],
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 0.6 },
      traces: { enabled: true, headSamplingRate: 0.05 },
    },
    // Worker source maps are private uploads: vite.config.ts builds them for the Worker environment only, and
    // `cf deploy` uploads the ones listed in the build output.
    env: {
      CLOUDFLARE_OAUTH_SCOPES: bindings.text(
        'account-settings.read user-details.read workers-scripts.write containers.write d1.write workers-r2.write workers-kv-storage.write ai.read',
      ),
      // Configure production secrets in Cloudflare, not local env files.
      // Deployment credentials are supplied by the CI environment, not as Worker runtime secrets.
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: bindings.secret(),
      CLOUDFLARE_OAUTH_CLIENT_SECRET: bindings.secret(),
      ...deployVar('COMMIT_SHA'),
      ...deployVar('CLOUDFLARE_OAUTH_CLIENT_ID'),
      // Migrations live in migrations/; scripts/apply-d1-migrations.mjs applies them to this database id.
      DB: bindings.d1({ name: 'cloudchef', id: '04680db0-07a0-468d-9547-e07f5091756c' }),
      USER_WORKSPACE_RUNTIME_PROVISIONING: bindings.workflow({
        name: 'cloudchef-user-workspace-runtime-provisioning',
        worker: 'cloudchef',
        exportName: 'UserWorkspaceRuntimeProvisioningWorkflow',
      }),
      CF_VERSION_METADATA: bindings.versionMetadata(),
      CLOUDFLARE_OAUTH_START_RATE_LIMITER: bindings.rateLimit({ namespace: '1002', simple: { limit: 10, period: 60 } }),
      CLIENT_TELEMETRY_RATE_LIMITER: bindings.rateLimit({ namespace: '1003', simple: { limit: 120, period: 60 } }),
    },
    exports: {
      UserWorkspaceRuntimeProvisioningWorkflow: exports.workflow({
        name: 'cloudchef-user-workspace-runtime-provisioning',
      }),
    },
  },
});
