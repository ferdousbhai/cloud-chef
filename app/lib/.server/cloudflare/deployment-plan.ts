import { sha256Hex } from '~/lib/hex-digest';
import { z } from 'zod';
import { appResourceName } from '~/lib/cloudflare/app-resource-names';
import type { DeploymentProjectProfile } from './deployment-project-profile';

const DEPLOYMENT_PLAN_VERSION = 5 as const;

export type DeploymentResourceType = 'worker' | 'd1' | 'r2' | 'kv' | 'durable_object' | 'workers_ai';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const deploymentProjectProfileSchema: z.ZodType<DeploymentProjectProfile> = z.strictObject({
  type: z.enum(['web_app', 'worker']),
  bindings: z.strictObject({
    ai: z.boolean(),
    d1: z.boolean(),
    r2: z.boolean(),
    kv: z.boolean(),
    appAgent: z.boolean(),
  }),
});
const deploymentPlanResourceSchema = z.strictObject({
  type: z.enum(['worker', 'd1', 'r2', 'kv', 'durable_object', 'workers_ai']),
  logicalName: z.string().min(1),
  proposedName: z.string().min(1),
});
const deploymentPlanSchema = z.strictObject({
  version: z.literal(DEPLOYMENT_PLAN_VERSION),
  deploymentId: z.string().min(1),
  sourceSha256: sha256Schema,
  project: deploymentProjectProfileSchema,
  resources: z.array(deploymentPlanResourceSchema),
});

export type DeploymentPlan = z.infer<typeof deploymentPlanSchema>;

export async function buildDeploymentPlanFromSource(args: {
  deploymentId: string;
  sourceSha256: string;
  project: DeploymentProjectProfile;
}): Promise<{ plan: DeploymentPlan; digest: string }> {
  if (!/^[a-f0-9]{64}$/.test(args.sourceSha256)) {
    throw new Error('Deployment source digest is invalid.');
  }
  const project = deploymentProjectProfileSchema.parse(args.project);
  const plan: DeploymentPlan = {
    version: DEPLOYMENT_PLAN_VERSION,
    deploymentId: args.deploymentId,
    sourceSha256: args.sourceSha256,
    project,
    resources: [
      { type: 'worker', logicalName: 'app', proposedName: appResourceName(args.deploymentId, 'app') },
      ...(project.bindings.d1
        ? [
            { type: 'd1' as const, logicalName: 'DB', proposedName: appResourceName(args.deploymentId, 'DB') },
            {
              type: 'd1' as const,
              logicalName: 'DB_PREVIEW',
              proposedName: appResourceName(args.deploymentId, 'DB_PREVIEW'),
            },
          ]
        : []),
      ...(project.bindings.appAgent
        ? [
            {
              type: 'd1' as const,
              logicalName: 'AGENT_SECURITY_DB',
              proposedName: appResourceName(args.deploymentId, 'AGENT_SECURITY_DB'),
            },
            {
              type: 'd1' as const,
              logicalName: 'AGENT_SECURITY_DB_PREVIEW',
              proposedName: appResourceName(args.deploymentId, 'AGENT_SECURITY_DB_PREVIEW'),
            },
          ]
        : []),
      ...(project.bindings.r2
        ? [
            {
              type: 'r2' as const,
              logicalName: 'APP_STORAGE',
              proposedName: appResourceName(args.deploymentId, 'APP_STORAGE'),
            },
          ]
        : []),
      ...(project.bindings.kv
        ? [
            {
              type: 'kv' as const,
              logicalName: 'APP_CACHE',
              proposedName: appResourceName(args.deploymentId, 'APP_CACHE'),
            },
          ]
        : []),
      ...(project.bindings.appAgent
        ? [{ type: 'durable_object' as const, logicalName: 'AppAgent', proposedName: 'AppAgent' }]
        : []),
      ...(project.bindings.ai ? [{ type: 'workers_ai' as const, logicalName: 'AI', proposedName: 'AI' }] : []),
    ],
  };
  const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify(plan)));
  return { plan, digest };
}

export function parseDeploymentPlanJson(value: string): DeploymentPlan {
  return deploymentPlanSchema.parse(JSON.parse(value));
}

export function isCurrentDeploymentPlan(plan: unknown): plan is DeploymentPlan {
  const parsed = deploymentPlanSchema.safeParse(plan);
  if (!parsed.success) {
    return false;
  }
  const current = parsed.data;
  // Every database the plan requires must be named, and no two of them may share a name: a
  // preview that resolved to the production database would write to it.
  const databaseNames = [
    ...(current.project.bindings.d1 ? ['DB', 'DB_PREVIEW'] : []),
    ...(current.project.bindings.appAgent ? ['AGENT_SECURITY_DB', 'AGENT_SECURITY_DB_PREVIEW'] : []),
  ].map((logicalName) => deploymentPlanResourceName(current, 'd1', logicalName));
  return databaseNames.every(Boolean) && new Set(databaseNames).size === databaseNames.length;
}

export function deploymentPlanResourceName(
  plan: DeploymentPlan,
  type: DeploymentResourceType,
  logicalName: string,
): string | null {
  const matches = plan.resources.filter((resource) => resource.type === type && resource.logicalName === logicalName);
  const name = matches.length === 1 ? matches[0].proposedName : '';
  const valid =
    type === 'durable_object' || type === 'workers_ai'
      ? /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(name)
      : /^[a-z0-9][a-z0-9-]{2,63}$/.test(name);
  return valid ? name : null;
}
