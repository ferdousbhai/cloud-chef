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
 * Managed applications intentionally expose unpromoted Worker versions through
 * versioned workers.dev preview URLs. Production workers.dev routing remains
 * enabled as well.
 */
export const DEPLOYMENT_PREVIEW_URLS_ENABLED = true as const;
