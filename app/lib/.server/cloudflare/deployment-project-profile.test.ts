import { describe, expect, test } from 'vitest';
import { deploymentProjectProfileFromProject } from './deployment-project-profile';

const d1 = { name: 'cloudchef-cloudflare-app', id: '00000000-0000-0000-0000-000000000000' };
const agentProject = {
  name: 'cloudchef-cloudflare-app',
  entrypoint: 'src/server.ts',
  d1,
  kv: { id: '0'.repeat(32) },
  r2: { name: 'cloudchef-cloudflare-app-storage' },
  agent: { securityD1: { name: 'cloudchef-cloudflare-app-agent-security', id: d1.id } },
};

describe('managed deployment capability boundary', () => {
  test('returns the exact provisioned and attested capability profile', () => {
    expect(deploymentProjectProfileFromProject(agentProject, 'web_app')).toEqual({
      type: 'web_app',
      bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true },
    });
  });

  test('accepts the plain web entrypoint when AppAgent is disabled', () => {
    expect(
      deploymentProjectProfileFromProject(
        { name: 'cloudchef-cloudflare-app', entrypoint: 'src/plain-server.ts' },
        'web_app',
      ),
    ).toEqual({
      type: 'web_app',
      bindings: { ai: false, d1: false, r2: false, kv: false, appAgent: false },
    });
  });

  test.each([
    [
      'plain web app',
      { name: 'cloudchef-cloudflare-app', entrypoint: 'src/server.ts' },
      'web_app',
      'src/plain-server.ts',
    ],
    ['AppAgent web app', { ...agentProject, entrypoint: 'src/plain-server.ts' }, 'web_app', 'src/server.ts'],
    ['Worker', { name: 'cloudchef-cloudflare-app', entrypoint: 'src/plain-server.ts' }, 'worker', 'src/server.ts'],
  ] as const)('rejects the wrong %s entrypoint', (_label, project, type, expected) => {
    expect(() => deploymentProjectProfileFromProject(project, type)).toThrow(
      `The generated Worker entrypoint must be ${expected} for this project profile.`,
    );
  });
});
