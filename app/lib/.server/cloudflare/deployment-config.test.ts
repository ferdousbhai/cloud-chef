import { describe, expect, test } from 'vitest';
import { createTrustedDeploymentConfig } from './deployment-config';

describe('trusted deployment config', () => {
  test('emits the cf Build Output shape with the managed bindings and cleanup schedule', () => {
    const config = createTrustedDeploymentConfig(input());

    expect(config.name).toBe('cloudchef-deployment-1');
    expect(config.manifest).toEqual({ type: 'partial', mainModule: 'index.js', modules: {} });
    expect(config.env).toEqual({
      DB: { type: 'd1', name: 'cloudchef-deployment-1', id: 'application-d1-id' },
      AGENT_SECURITY_DB: { type: 'd1', name: 'cloudchef-deployment-1-agent-security', id: 'agent-security-d1-id' },
      APP_STORAGE: { type: 'r2', name: 'cloudchef-deployment-1-storage' },
      APP_CACHE: { type: 'kv', id: '1'.repeat(32) },
      AI: { type: 'ai' },
      AppAgent: { type: 'durable-object', worker: 'cloudchef-deployment-1', exportName: 'AppAgent' },
    });
    expect(config.exports).toEqual({ AppAgent: { type: 'durable-object', storage: 'sqlite' } });
    expect(config.triggers).toEqual([{ type: 'scheduled', schedule: '0 3 * * *' }]);
  });

  test('omits the AppAgent capability and absent resources', () => {
    const config = createTrustedDeploymentConfig({
      workerName: 'cloudchef-deployment-1',
      workersAi: false,
      appAgent: false,
    });

    expect(config.env).toEqual({});
    expect(config.assets).toBeUndefined();
    expect(config.exports).toBeUndefined();
    expect(config.triggers).toBeUndefined();
  });

  test('routes pages through the Worker first when the project serves static assets', () => {
    const config = createTrustedDeploymentConfig({
      workerName: 'cloudchef-deployment-1',
      workersAi: false,
      appAgent: false,
      assets: true,
    });

    expect(config.env).toEqual({ ASSETS: { type: 'assets' } });
    expect(config.assets).toEqual({ runWorkerFirst: ['/*', '!/assets/*'] });
  });

  test('rejects an invalid KV namespace id', () => {
    expect(() => createTrustedDeploymentConfig({ ...input(), kvNamespaceId: 'not-hex' })).toThrow(SyntaxError);
  });
});

function input() {
  return {
    workerName: 'cloudchef-deployment-1',
    workersAi: true,
    appAgent: true,
    d1DatabaseId: 'application-d1-id',
    d1DatabaseName: 'cloudchef-deployment-1',
    agentSecurityD1DatabaseId: 'agent-security-d1-id',
    agentSecurityD1DatabaseName: 'cloudchef-deployment-1-agent-security',
    r2BucketName: 'cloudchef-deployment-1-storage',
    kvNamespaceId: '1'.repeat(32),
  };
}
