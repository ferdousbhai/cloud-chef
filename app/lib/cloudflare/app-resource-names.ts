import { sha256Hex } from '~/lib/hex-digest';

const APP_RESOURCE_PREFIX = 'cloudchef-';

/**
 * Suffix per logical binding name. The Worker anchors the app and carries no suffix, and neither
 * does the application database - they are distinguished by resource type, not by name.
 */
const APP_RESOURCE_SUFFIXES = {
  app: '',
  DB: '',
  AGENT_SECURITY_DB: '-agent-security',
  APP_STORAGE: '-storage',
  APP_CACHE: '-cache',
} as const;

export type AppResourceLogicalName = keyof typeof APP_RESOURCE_SUFFIXES;

/**
 * The identity a CloudChef app's account resources are named after: one per project, so every
 * revision deploys onto the same Worker, databases, bucket and namespace.
 */
export async function appResourceIdentity(projectId: string): Promise<string> {
  const hex = await sha256Hex(`cloudchef-app:${projectId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function appResourceName(identity: string, logicalName: AppResourceLogicalName): string {
  return `${APP_RESOURCE_PREFIX}${identity}${APP_RESOURCE_SUFFIXES[logicalName]}`;
}
