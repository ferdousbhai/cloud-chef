import { describe, expect, it } from 'vitest';
import {
  buildDeploymentPlanFromSource,
  deploymentPlanResourceName,
  isCurrentDeploymentPlan,
  parseDeploymentPlanJson,
  type DeploymentResourceNaming,
} from './deployment-plan';

const SOURCE_ONE = '1'.repeat(64);
const SOURCE_TWO = '2'.repeat(64);
const NAMING: DeploymentResourceNaming = { identity: 'app-1' };
const EVERY_BINDING = {
  type: 'web_app' as const,
  bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true },
};

describe('buildDeploymentPlanFromSource', () => {
  it('binds the exact revision and resource intent into an immutable plan', async () => {
    const result = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_ONE,
      naming: NAMING,
      project: { type: 'web_app', bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true } },
    });

    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plan).toMatchObject({
      version: 5,
      sourceSha256: SOURCE_ONE,
    });
    expect(result.plan.resources.map(({ type }) => type)).toEqual([
      'worker',
      'worker',
      'd1',
      'd1',
      'd1',
      'd1',
      'r2',
      'r2',
      'kv',
      'kv',
      'durable_object',
      'workers_ai',
    ]);
  });

  it('changes the plan digest when the exact backup revision changes', async () => {
    const project = { type: 'web_app' as const, bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true } };
    const first = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_ONE,
      naming: NAMING,
      project,
    });
    const second = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_TWO,
      naming: NAMING,
      project,
    });
    expect(first.digest).not.toBe(second.digest);
  });

  it('plans only resources declared by a Worker without ambient AI access', async () => {
    const result = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_ONE,
      naming: NAMING,
      project: { type: 'worker', bindings: { ai: false, d1: false, r2: false, kv: false, appAgent: false } },
    });
    // Even a plain Worker previews on a Worker of its own.
    expect(result.plan.resources.map(({ logicalName }) => logicalName)).toEqual(['app', 'app_preview']);
  });

  it('returns only one valid resource name for trusted provisioning', async () => {
    const { plan } = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-2',
      sourceSha256: SOURCE_ONE,
      naming: NAMING,
      project: { type: 'web_app', bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true } },
    });
    expect(deploymentPlanResourceName(plan, 'worker', 'app')).toBe('cloudchef-app-1');
    expect(deploymentPlanResourceName(plan, 'worker', 'app_preview')).toBe('app-1-cloudchef-app-1-preview');
    expect(deploymentPlanResourceName(plan, 'd1', 'DB_PREVIEW')).toBe('cloudchef-app-1-preview');
    expect(deploymentPlanResourceName(plan, 'r2', 'APP_STORAGE_PREVIEW')).toBe('cloudchef-app-1-preview-storage');
    expect(deploymentPlanResourceName(plan, 'kv', 'APP_CACHE_PREVIEW')).toBe('cloudchef-app-1-preview-cache');
    expect(deploymentPlanResourceName(plan, 'd1', 'AGENT_SECURITY_DB')).toBe('cloudchef-app-1-agent-security');
    expect(deploymentPlanResourceName(plan, 'd1', 'AGENT_SECURITY_DB_PREVIEW')).toBe('cloudchef-app-1-preview-agent');
    expect(deploymentPlanResourceName(plan, 'workers_ai', 'AI')).toBe('AI');
    expect(deploymentPlanResourceName(plan, 'durable_object', 'AppAgent')).toBe('AppAgent');
    expect(
      deploymentPlanResourceName(
        { ...plan, resources: [...plan.resources, { ...plan.resources[0] }] },
        'worker',
        'app',
      ),
    ).toBeNull();
  });

  it('rejects a source reference that is not an exact SHA-256 revision', async () => {
    await expect(
      buildDeploymentPlanFromSource({
        deploymentId: 'deployment-1',
        sourceSha256: 'latest',
        naming: NAMING,
        project: { type: 'worker', bindings: { ai: false, d1: false, r2: false, kv: false, appAgent: false } },
      }),
    ).rejects.toThrow('Deployment source digest is invalid.');
  });

  it('rejects persisted plans without a complete project profile', async () => {
    const { plan } = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_ONE,
      naming: NAMING,
      project: { type: 'worker', bindings: { ai: false, d1: false, r2: false, kv: false, appAgent: false } },
    });
    const { project: _project, ...missingProject } = plan;

    expect(parseDeploymentPlanJson(JSON.stringify(plan))).toEqual(plan);
    expect(isCurrentDeploymentPlan(plan)).toBe(true);
    expect(isCurrentDeploymentPlan(missingProject)).toBe(false);
    // A plan that names no preview Worker is not one this release makes.
    expect(
      isCurrentDeploymentPlan({
        ...plan,
        resources: plan.resources.filter((resource) => resource.logicalName !== 'app_preview'),
      }),
    ).toBe(false);
    expect(() => parseDeploymentPlanJson(JSON.stringify(missingProject))).toThrow();
    expect(() =>
      parseDeploymentPlanJson(JSON.stringify({ ...plan, project: { type: 'worker', bindings: { ai: false } } })),
    ).toThrow();
  });

  it('refuses a plan whose preview would publish to one of production’s resources', async () => {
    const { plan } = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_ONE,
      naming: NAMING,
      project: EVERY_BINDING,
    });
    const production = (logicalName: string) =>
      plan.resources.find((resource) => resource.logicalName === logicalName)?.proposedName ?? '';
    const sharing = (previewName: string, productionName: string) => ({
      ...plan,
      resources: plan.resources.map((resource) =>
        resource.logicalName === previewName ? { ...resource, proposedName: production(productionName) } : resource,
      ),
    });

    expect(isCurrentDeploymentPlan(plan)).toBe(true);
    expect(isCurrentDeploymentPlan(sharing('app_preview', 'app'))).toBe(false);
    expect(isCurrentDeploymentPlan(sharing('DB_PREVIEW', 'DB'))).toBe(false);
    expect(isCurrentDeploymentPlan(sharing('AGENT_SECURITY_DB_PREVIEW', 'AGENT_SECURITY_DB'))).toBe(false);
    expect(isCurrentDeploymentPlan(sharing('APP_STORAGE_PREVIEW', 'APP_STORAGE'))).toBe(false);
    expect(isCurrentDeploymentPlan(sharing('APP_CACHE_PREVIEW', 'APP_CACHE'))).toBe(false);
    // The Worker and the database share a name, being resources of different types.
    expect(production('app')).toBe(production('DB'));
  });

  it('names every revision’s account resources after the project, not the deployment', async () => {
    const first = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_ONE,
      naming: NAMING,
      project: EVERY_BINDING,
    });
    const second = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-2',
      sourceSha256: SOURCE_TWO,
      naming: NAMING,
      project: EVERY_BINDING,
    });

    expect(second.plan.resources).toEqual(first.plan.resources);
    expect(first.plan.resources.map(({ proposedName }) => proposedName)).toEqual([
      'cloudchef-app-1',
      'app-1-cloudchef-app-1-preview',
      'cloudchef-app-1',
      'cloudchef-app-1-preview',
      'cloudchef-app-1-agent-security',
      'cloudchef-app-1-preview-agent',
      'cloudchef-app-1-storage',
      'cloudchef-app-1-preview-storage',
      'cloudchef-app-1-cache',
      'cloudchef-app-1-preview-cache',
      'AppAgent',
      'AI',
    ]);
  });
});

/** Account resources are named after their project; Durable Objects and AI are binding classes. */
