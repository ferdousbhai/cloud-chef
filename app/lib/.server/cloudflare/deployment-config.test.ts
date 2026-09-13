import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { createTrustedDeploymentConfig } from './deployment-config';
import { DEPLOYMENT_PROJECT_ROOT } from './deployment-runtime-policy';

describe('trusted deployment config', () => {
  test('resolves every generated-project path beneath the Computer project root', () => {
    const webConfig = createTrustedDeploymentConfig(input({ projectType: 'web_app' }));
    const workerConfig = createTrustedDeploymentConfig(input({ projectType: 'worker' }));
    const generatedProjectPaths = [
      webConfig.main,
      webConfig.assets?.directory,
      workerConfig.main,
      ...webConfig.d1_databases!.map((database) => database.migrations_dir),
    ];

    expect(generatedProjectPaths).not.toContain(undefined);
    for (const generatedPath of generatedProjectPaths) {
      expect(path.posix.isAbsolute(generatedPath!)).toBe(true);
      expect(generatedPath!.startsWith(`${DEPLOYMENT_PROJECT_ROOT}/`)).toBe(true);
    }
  });

  test('emits the managed bindings and cleanup cron', () => {
    const config = createTrustedDeploymentConfig(input());
    const agentSecurityDatabase = config.d1_databases!.find((database) => database.binding === 'AGENT_SECURITY_DB')!;

    expect(config.kv_namespaces).toEqual([{ binding: 'APP_CACHE', id: '1'.repeat(32) }]);
    expect(agentSecurityDatabase.database_id).toBe('agent-security-d1-id');
    expect(config.triggers?.crons).toHaveLength(1);
  });
});

function input(overrides: { projectType?: 'web_app' | 'worker' } = {}) {
  return {
    accountId: 'account-id',
    workerName: 'ghostbuild-deployment-1',
    projectType: overrides.projectType ?? ('web_app' as const),
    workersAi: true,
    appAgent: true,
    d1DatabaseId: 'application-d1-id',
    d1DatabaseName: 'ghostbuild-deployment-1',
    agentSecurityD1DatabaseId: 'agent-security-d1-id',
    agentSecurityD1DatabaseName: 'ghostbuild-deployment-1-agent-security',
    r2BucketName: 'ghostbuild-deployment-1-storage',
    kvNamespaceId: '1'.repeat(32),
  };
}
