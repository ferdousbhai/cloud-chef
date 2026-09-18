const APP_RESOURCE_PREFIX = 'cloudchef-';

/**
 * Suffix per logical binding name. The Worker anchors the deployment and carries no suffix, and
 * neither does the application database - they are distinguished by resource type, not by name.
 */
const APP_RESOURCE_SUFFIXES = {
  app: '',
  DB: '',
  DB_PREVIEW: '-preview',
  AGENT_SECURITY_DB: '-agent-security',
  AGENT_SECURITY_DB_PREVIEW: '-preview-agent',
  APP_STORAGE: '-storage',
  APP_CACHE: '-cache',
} as const;

type AppResourceLogicalName = keyof typeof APP_RESOURCE_SUFFIXES;

export function appResourceName(deploymentId: string, logicalName: AppResourceLogicalName): string {
  return `${APP_RESOURCE_PREFIX}${deploymentId}${APP_RESOURCE_SUFFIXES[logicalName]}`;
}
