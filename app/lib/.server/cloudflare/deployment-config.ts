import { WORKER_MAIN_MODULE } from './deployment-artifact';
import {
  APP_AGENT_DECLARATIVE_EXPORT,
  DEPLOYMENT_COMPATIBILITY_DATE,
  DEPLOYMENT_COMPATIBILITY_FLAGS,
  DEPLOYMENT_OBSERVABILITY,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
} from './deployment-runtime-policy';

export type DeploymentConfigInput = {
  workerName: string;
  workersAi: boolean;
  appAgent: boolean;
  d1DatabaseId?: string;
  d1DatabaseName?: string;
  agentSecurityD1DatabaseId?: string;
  agentSecurityD1DatabaseName?: string;
  r2BucketName?: string;
  kvNamespaceId?: string;
};

type TrustedBinding =
  | { type: 'd1'; name: string; id: string }
  | { type: 'r2'; name: string }
  | { type: 'kv'; id: string }
  | { type: 'ai' }
  | { type: 'durable-object'; worker: string; exportName: 'AppAgent' };

type TrustedDeploymentConfig = {
  name: string;
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
  observability: typeof CF_OBSERVABILITY;
  workersDev: true;
  env: Partial<Record<'DB' | 'AGENT_SECURITY_DB' | 'APP_STORAGE' | 'APP_CACHE' | 'AI' | 'AppAgent', TrustedBinding>>;
  exports?: { AppAgent: typeof APP_AGENT_DECLARATIVE_EXPORT };
  triggers?: Array<{ type: 'scheduled'; schedule: typeof DEPLOYMENT_SECURITY_CLEANUP_CRON }>;
  manifest: { type: 'partial'; mainModule: typeof WORKER_MAIN_MODULE; modules: Record<string, never> };
};

/** The same policy as the Workers API form, in cf's camelCase Build Output shape. */
const CF_OBSERVABILITY = {
  enabled: DEPLOYMENT_OBSERVABILITY.enabled,
  logs: {
    enabled: DEPLOYMENT_OBSERVABILITY.logs.enabled,
    headSamplingRate: DEPLOYMENT_OBSERVABILITY.logs.head_sampling_rate,
  },
  traces: {
    enabled: DEPLOYMENT_OBSERVABILITY.traces.enabled,
    headSamplingRate: DEPLOYMENT_OBSERVABILITY.traces.head_sampling_rate,
  },
} as const;

/**
 * The resolved `cf` Build Output configuration (`worker.config.json`) for the validation dry run.
 *
 * It is rebuilt from trusted inputs and written over whatever the project's own build resolved, so
 * a generated `cloudflare.config.ts` cannot change deployment policy.
 */
export function createTrustedDeploymentConfig(args: DeploymentConfigInput): TrustedDeploymentConfig {
  const config: TrustedDeploymentConfig = {
    name: requireCloudflareName(args.workerName, 'workerName'),
    compatibilityDate: DEPLOYMENT_COMPATIBILITY_DATE,
    compatibilityFlags: DEPLOYMENT_COMPATIBILITY_FLAGS,
    observability: CF_OBSERVABILITY,
    workersDev: true,
    env: {},
    manifest: { type: 'partial', mainModule: WORKER_MAIN_MODULE, modules: {} },
  };
  if (args.d1DatabaseId !== undefined) {
    config.env.DB = {
      type: 'd1',
      name: requireCloudflareName(args.d1DatabaseName, 'd1DatabaseName'),
      id: requireString(args.d1DatabaseId, 'd1DatabaseId', 64),
    };
  }
  if (args.agentSecurityD1DatabaseId !== undefined) {
    config.env.AGENT_SECURITY_DB = {
      type: 'd1',
      name: requireCloudflareName(args.agentSecurityD1DatabaseName, 'agentSecurityD1DatabaseName'),
      id: requireString(args.agentSecurityD1DatabaseId, 'agentSecurityD1DatabaseId', 64),
    };
  }
  if (args.r2BucketName !== undefined) {
    config.env.APP_STORAGE = { type: 'r2', name: requireCloudflareName(args.r2BucketName, 'r2BucketName') };
  }
  if (args.kvNamespaceId !== undefined) {
    config.env.APP_CACHE = { type: 'kv', id: requireHexId(args.kvNamespaceId, 'kvNamespaceId') };
  }
  if (args.workersAi) {
    config.env.AI = { type: 'ai' };
  }
  if (args.appAgent) {
    config.env.AppAgent = { type: 'durable-object', worker: config.name, exportName: 'AppAgent' };
    config.exports = { AppAgent: APP_AGENT_DECLARATIVE_EXPORT };
    config.triggers = [{ type: 'scheduled', schedule: DEPLOYMENT_SECURITY_CLEANUP_CRON }];
  }
  return config;
}

function requireHexId(value: unknown, name: string): string {
  const result = requireString(value, name, 64);
  if (!/^[a-f0-9]{32}$/.test(result)) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return result;
}

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return value;
}

function requireCloudflareName(value: unknown, name: string): string {
  const result = requireString(value, name, 64);
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(result)) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return result;
}
