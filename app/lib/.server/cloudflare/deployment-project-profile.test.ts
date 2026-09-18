import { describe, expect, test } from 'vitest';
import { deploymentProjectProfileFromConfig } from './deployment-project-profile';

const supportedConfig = {
  main: 'src/server.ts',
  ai: { binding: 'AI' },
  d1_databases: [{ binding: 'DB' }, { binding: 'AGENT_SECURITY_DB' }],
  r2_buckets: [{ binding: 'APP_STORAGE' }],
  kv_namespaces: [{ binding: 'APP_CACHE' }],
  durable_objects: { bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] },
  exports: { AppAgent: { type: 'durable-object', storage: 'sqlite' } },
  triggers: { crons: ['0 3 * * *'] },
};

describe('managed deployment capability boundary', () => {
  test('returns the exact provisioned and attested capability profile', () => {
    expect(deploymentProjectProfileFromConfig(supportedConfig, 'web_app')).toEqual({
      type: 'web_app',
      bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true },
    });
  });

  test.each(['queues', 'vectorize', 'hyperdrive', 'workflows', 'flagship', 'ai_search', 'worker_loaders'])(
    'rejects unsupported %s configuration instead of silently dropping it',
    (key) => {
      expect(() =>
        deploymentProjectProfileFromConfig({ ...supportedConfig, [key]: [{ binding: 'EXTRA' }] }, 'web_app'),
      ).toThrow(`CloudChef managed deployment does not support these Wrangler capabilities: ${key}.`);
    },
  );

  test('rejects unknown KV binding names', () => {
    expect(() =>
      deploymentProjectProfileFromConfig(
        { ...supportedConfig, kv_namespaces: [{ binding: 'OTHER_CACHE' }] },
        'web_app',
      ),
    ).toThrow('CloudChef managed deployment supports only these KV bindings: APP_CACHE.');
  });

  test('rejects unknown binding names on otherwise supported products', () => {
    expect(() =>
      deploymentProjectProfileFromConfig(
        { ...supportedConfig, d1_databases: [...supportedConfig.d1_databases, { binding: 'ANALYTICS' }] },
        'web_app',
      ),
    ).toThrow('CloudChef managed deployment supports only these D1 bindings: DB, AGENT_SECURITY_DB.');
  });

  test('requires AppAgent, its security database, export, and cleanup cron as one capability', () => {
    expect(() =>
      deploymentProjectProfileFromConfig({ ...supportedConfig, d1_databases: [{ binding: 'DB' }] }, 'web_app'),
    ).toThrow('The AppAgent and AGENT_SECURITY_DB managed deployment capabilities must be configured together.');
  });

  test('accepts the plain web entrypoint when AppAgent is disabled', () => {
    expect(deploymentProjectProfileFromConfig({ main: 'src/plain-server.ts' }, 'web_app')).toEqual({
      type: 'web_app',
      bindings: { ai: false, d1: false, r2: false, kv: false, appAgent: false },
    });
  });

  test.each([
    ['plain web app', { main: 'src/server.ts' }, 'web_app', 'src/plain-server.ts'],
    ['AppAgent web app', { ...supportedConfig, main: 'src/plain-server.ts' }, 'web_app', 'src/server.ts'],
    ['Worker', { main: 'src/plain-server.ts' }, 'worker', 'src/server.ts'],
  ] as const)('rejects the wrong %s entrypoint', (_label, config, type, expected) => {
    expect(() => deploymentProjectProfileFromConfig(config, type)).toThrow(
      `The generated Worker entrypoint must be ${expected} for this project profile.`,
    );
  });
});
