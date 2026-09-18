import { APP_AGENT_DECLARATIVE_EXPORT, DEPLOYMENT_SECURITY_CLEANUP_CRON } from './deployment-runtime-policy';

export type DeploymentProjectType = 'web_app' | 'worker';

export type DeploymentProjectProfile = {
  type: DeploymentProjectType;
  bindings: {
    ai: boolean;
    d1: boolean;
    r2: boolean;
    kv: boolean;
    appAgent: boolean;
  };
};

const UNSUPPORTED_MANAGED_DEPLOYMENT_KEYS = [
  'agent_memory',
  'ai_search',
  'analytics_engine_datasets',
  'assets',
  'browser',
  'containers',
  'data_blobs',
  'dispatch_namespaces',
  'flagship',
  'hyperdrive',
  'images',
  'logfwdr',
  'mtls_certificates',
  'pipelines',
  'queues',
  'secrets_store_secrets',
  'send_email',
  'services',
  'tail_consumers',
  'text_blobs',
  'unsafe',
  'vars',
  'vectorize',
  'version_metadata',
  'wasm_modules',
  'worker_loaders',
  'workflows',
] as const;

/** Resolve only capabilities the managed publisher can provision, publish, and attest without silently dropping any. */
export function deploymentProjectProfileFromConfig(
  config: Record<string, unknown>,
  type: DeploymentProjectType,
): DeploymentProjectProfile {
  const unsupported = UNSUPPORTED_MANAGED_DEPLOYMENT_KEYS.filter((key) => hasConfiguredValue(config[key]));
  if (unsupported.length > 0) {
    throw new Error(
      `CloudChef managed deployment does not support these Wrangler capabilities: ${unsupported.join(', ')}.`,
    );
  }

  const ai = recordOrNull(config.ai);
  if (ai && (ai.binding !== 'AI' || Object.keys(ai).some((key) => key !== 'binding'))) {
    throw new Error('CloudChef managed deployment supports only the AI Workers AI binding.');
  }
  const d1Bindings = requireExactBindings(config.d1_databases, 'D1', ['DB', 'AGENT_SECURITY_DB']);
  const r2Bindings = requireExactBindings(config.r2_buckets, 'R2', ['APP_STORAGE']);
  const kvBindings = requireExactBindings(config.kv_namespaces, 'KV', ['APP_CACHE']);
  const durableObjects = recordOrNull(config.durable_objects);
  const durableBindingEntries = Array.isArray(durableObjects?.bindings) ? durableObjects.bindings : [];
  const durableBindings = requireExactBindings(durableObjects?.bindings, 'Durable Object', ['AppAgent'], 'name');
  const appAgent = durableBindings.has('AppAgent');
  if (
    appAgent &&
    !durableBindingEntries.every(
      (entry) => recordOrNull(entry)?.name === 'AppAgent' && recordOrNull(entry)?.class_name === 'AppAgent',
    )
  ) {
    throw new Error('CloudChef managed deployment supports only the AppAgent Durable Object binding.');
  }
  if (appAgent !== d1Bindings.has('AGENT_SECURITY_DB')) {
    throw new Error('The AppAgent and AGENT_SECURITY_DB managed deployment capabilities must be configured together.');
  }
  assertManagedExports(config.exports, appAgent);
  assertManagedTriggers(config.triggers, appAgent);
  const expectedEntrypoint = type === 'worker' || appAgent ? 'src/server.ts' : 'src/plain-server.ts';
  if (config.main !== expectedEntrypoint) {
    throw new Error(`The generated Worker entrypoint must be ${expectedEntrypoint} for this project profile.`);
  }

  return {
    type,
    bindings: {
      ai: ai !== null,
      d1: d1Bindings.has('DB'),
      r2: r2Bindings.has('APP_STORAGE'),
      kv: kvBindings.has('APP_CACHE'),
      appAgent,
    },
  };
}

function requireExactBindings(value: unknown, label: string, allowed: readonly string[], key = 'binding'): Set<string> {
  if (value === undefined) {
    return new Set();
  }
  if (!Array.isArray(value)) {
    throw new Error(`The generated ${label} bindings are invalid.`);
  }
  const names = value
    .map((entry) => recordOrNull(entry)?.[key])
    .filter((name): name is string => typeof name === 'string');
  if (
    names.length !== value.length ||
    new Set(names).size !== names.length ||
    names.some((name) => !allowed.includes(name))
  ) {
    throw new Error(`CloudChef managed deployment supports only these ${label} bindings: ${allowed.join(', ')}.`);
  }
  return new Set(names);
}

function assertManagedExports(value: unknown, appAgent: boolean): void {
  const exports = recordOrNull(value);
  const names = exports ? Object.keys(exports) : [];
  if (
    (appAgent &&
      (names.length !== 1 ||
        names[0] !== 'AppAgent' ||
        JSON.stringify(exports?.AppAgent) !== JSON.stringify(APP_AGENT_DECLARATIVE_EXPORT))) ||
    (!appAgent && names.length > 0)
  ) {
    throw new Error('CloudChef managed deployment supports only the AppAgent Durable Object export.');
  }
}

function assertManagedTriggers(value: unknown, appAgent: boolean): void {
  if (value === undefined) {
    if (appAgent) {
      throw new Error('The AppAgent managed deployment requires its security cleanup schedule.');
    }
    return;
  }
  const triggers = recordOrNull(value);
  const crons = triggers?.crons;
  if (
    !appAgent ||
    !Array.isArray(crons) ||
    crons.length !== 1 ||
    crons[0] !== DEPLOYMENT_SECURITY_CLEANUP_CRON ||
    Object.keys(triggers!).some((key) => key !== 'crons')
  ) {
    throw new Error('CloudChef managed deployment supports only the AppAgent security cleanup schedule.');
  }
}

function hasConfiguredValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value) || typeof value === 'string') {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return true;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
