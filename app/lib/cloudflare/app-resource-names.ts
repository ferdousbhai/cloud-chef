import { sha256Hex } from '~/lib/hex-digest';

const APP_RESOURCE_PREFIX = 'cloudchef-';

/**
 * Suffix per logical binding name. The Worker anchors the app and carries no suffix, and neither
 * does the application database - they are distinguished by resource type, not by name, as the
 * preview Worker and the preview database are.
 */
const APP_RESOURCE_SUFFIXES = {
  app: '',
  app_preview: '-preview',
  DB: '',
  DB_PREVIEW: '-preview',
  AGENT_SECURITY_DB: '-agent-security',
  AGENT_SECURITY_DB_PREVIEW: '-preview-agent',
  APP_STORAGE: '-storage',
  APP_STORAGE_PREVIEW: '-preview-storage',
  APP_CACHE: '-cache',
  APP_CACHE_PREVIEW: '-preview-cache',
} as const;

export type AppResourceLogicalName = keyof typeof APP_RESOURCE_SUFFIXES;

/**
 * The identity a CloudChef app's account resources are named after: one per project, so every
 * revision deploys onto the same Worker, databases, bucket and namespace. Before this, each deployment
 * named its own after its id, which is the same shape, so an app that adopted those keeps them.
 */
export async function appResourceIdentity(projectId: string): Promise<string> {
  const hex = await sha256Hex(`cloudchef-app:${projectId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function appResourceName(identity: string, logicalName: AppResourceLogicalName): string {
  return `${APP_RESOURCE_PREFIX}${identity}${APP_RESOURCE_SUFFIXES[logicalName]}`;
}
