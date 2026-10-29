import { bindings, defineConfig, exports, triggers } from 'cf/config';

// Deploy tooling injects the environment-specific OAuth client id and commit SHA: scripts/deploy-production.mjs
// sets both in the environment of the build it then ships, so the values reach the Worker as plain-text vars
// without ever being committed. Absent values are left unbound.
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
    // No preview URLs: every version of this Worker carries production's D1 and secrets.
    previewUrls: false,
    domains: ['cloudchef.build', 'www.cloudchef.build'],
    triggers: [triggers.scheduled({ schedule: '*/15 * * * *' })],
    observability: {
      redactQueryString: true,
      enabled: true,
      logs: { enabled: true, headSamplingRate: 0.6 },
      traces: { enabled: true, headSamplingRate: 0.05 },
    },
    // Worker source maps are private uploads: vite.config.ts builds them for the Worker environment only, and
    // `cf deploy` uploads the ones listed in the build output.
    env: {
      // Configure production secrets in Cloudflare, not local env files.
      // Deployment credentials are supplied by the CI environment, not as Worker runtime secrets.
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: bindings.secret(),
      CLOUDFLARE_OAUTH_CLIENT_SECRET: bindings.secret(),
      // Sign in with Google, for people without a Cloudflare login. Unset, the option reports itself unavailable.
      GOOGLE_OAUTH_CLIENT_ID: bindings.secret(),
      GOOGLE_OAUTH_CLIENT_SECRET: bindings.secret(),
      // CloudChef's GitHub App, for organization projects kept in GitHub. Unset, they report themselves
      // unavailable. The private key is PKCS#8 (app/lib/.server/github/app-jwt.ts).
      GITHUB_APP_CLIENT_ID: bindings.secret(),
      GITHUB_APP_CLIENT_SECRET: bindings.secret(),
      GITHUB_APP_PRIVATE_KEY: bindings.secret(),
      GITHUB_APP_SLUG: bindings.secret(),
      // Whose outdated workspace runtimes are upgraded: empty for everyone, or comma-separated CloudChef user ids
      // for a canary (app/lib/.server/cloudflare/user-workspace-runtime-rollout.ts). Changed by a release, never
      // in the dashboard.
      WORKSPACE_RUNTIME_UPGRADE_CANARY: bindings.text(''),
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
      SIGN_IN_RATE_LIMITER: bindings.rateLimit({ namespace: '1004', simple: { limit: 10, period: 60 } }),
      // Calls to the runtime routes (/api/cloudflare/runtime-*), keyed by the caller's bearer secret: every
      // runtime's Worker reaches CloudChef from the same Cloudflare egress address, so an IP key would be one
      // shared bucket. app/server.ts.
      RUNTIME_RATE_LIMITER: bindings.rateLimit({ namespace: '1005', simple: { limit: 600, period: 60 } }),
      // Emailed sign-in links (app/server-handlers/email-auth.ts), sent through Cloudflare Email Service.
      SIGN_IN_EMAIL: bindings.sendEmail({ allowedSenderAddresses: ['noreply@cloudchef.build'] }),
    },
    exports: {
      UserWorkspaceRuntimeProvisioningWorkflow: exports.workflow({
        name: 'cloudchef-user-workspace-runtime-provisioning',
      }),
    },
  },
});
