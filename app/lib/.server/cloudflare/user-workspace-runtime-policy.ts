/** One deterministic control-plane sweep for inactive user-owned runtimes every 15 minutes. */
export const USER_WORKSPACE_RUNTIME_GC_CRON = '*/15 * * * *';

/**
 * Canonical production credential-broker origin. Forks must replace this HTTPS
 * origin, regenerate the runtime bundle, and re-provision existing runtimes.
 */
export const CLOUDCHEF_CONTROL_PLANE_ENDPOINT = 'https://cloudchef.build';
