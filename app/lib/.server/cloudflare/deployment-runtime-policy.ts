export const DEPLOYMENT_COMPATIBILITY_DATE = '2026-07-21';
export const DEPLOYMENT_COMPATIBILITY_FLAGS = ['nodejs_compat'] as const;
export const DEPLOYMENT_OBSERVABILITY = {
  enabled: true,
  logs: { enabled: true, head_sampling_rate: 0.6 },
  traces: { enabled: true, head_sampling_rate: 0.05 },
} as const;
export const APP_AGENT_DECLARATIVE_EXPORT = {
  type: 'durable-object',
  storage: 'sqlite',
} as const;

export const DEPLOYMENT_SECURITY_CLEANUP_CRON = '0 3 * * *';
/**
 * A project declaring `assets` routes pages and API through its Worker first, so the application's
 * security headers reach every HTML response; Vite's hashed bundles under /assets stay static hits.
 */
export const DEPLOYMENT_ASSETS_RUN_WORKER_FIRST = ['/*', '!/assets/*'] as const;
/**
 * A Worker CloudChef publishes serves only its active version, at its workers.dev address. Versioned
 * preview URLs would keep every earlier version reachable, each bound to the data it was published
 * with, so they stay off: a preview is the active version of the project's preview Worker instead.
 */
export const DEPLOYMENT_PREVIEW_URLS_ENABLED = false as const;
