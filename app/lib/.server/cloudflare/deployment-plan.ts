import { sha256Hex } from '~/lib/hex-digest';
import { z } from 'zod';
import { appResourceName, type AppResourceLogicalName } from '~/lib/cloudflare/app-resource-names';
import type { DeploymentProjectProfile } from './deployment-project-profile';

const DEPLOYMENT_PLAN_VERSION = 5 as const;

type DeploymentResourceType = 'worker' | 'd1' | 'r2' | 'kv' | 'durable_object' | 'workers_ai';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const deploymentProjectProfileSchema: z.ZodType<DeploymentProjectProfile> = z.strictObject({
  type: z.enum(['web_app', 'worker']),
  bindings: z.strictObject({
    ai: z.boolean(),
    d1: z.boolean(),
    r2: z.boolean(),
    kv: z.boolean(),
    appAgent: z.boolean(),
    assets: z.boolean().optional(),
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

/** The account resources a plan may name, as (type, logical name): the ones a deployment creates. */
export const APP_ACCOUNT_RESOURCES = [
  ['worker', 'app'],
  ['d1', 'DB'],
  ['d1', 'AGENT_SECURITY_DB'],
  ['kv', 'APP_CACHE'],
  ['r2', 'APP_STORAGE'],
] as const satisfies readonly (readonly [DeploymentResourceType, AppResourceLogicalName])[];

type AppAccountResource = (typeof APP_ACCOUNT_RESOURCES)[number];

/**
 * How a project's plans name its account resources: after the project's own identity, so every
 * revision of it names the same ones.
 */
export type DeploymentResourceNaming = { identity: string };

export async function buildDeploymentPlanFromSource(args: {
  deploymentId: string;
  sourceSha256: string;
  project: DeploymentProjectProfile;
  naming: DeploymentResourceNaming;
}): Promise<{ plan: DeploymentPlan; digest: string }> {
  if (!/^[a-f0-9]{64}$/.test(args.sourceSha256)) {
    throw new Error('Deployment source digest is invalid.');
  }
  const project = deploymentProjectProfileSchema.parse(args.project);
  const account = (resource: AppAccountResource) => ({
    type: resource[0],
    logicalName: resource[1],
    proposedName: appResourceName(args.naming.identity, resource[1]),
  });
  const plan: DeploymentPlan = {
    version: DEPLOYMENT_PLAN_VERSION,
    deploymentId: args.deploymentId,
    sourceSha256: args.sourceSha256,
    project,
    resources: [
      account(['worker', 'app']),
      ...(project.bindings.d1 ? [account(['d1', 'DB'])] : []),
      ...(project.bindings.appAgent ? [account(['d1', 'AGENT_SECURITY_DB'])] : []),
      ...(project.bindings.r2 ? [account(['r2', 'APP_STORAGE'])] : []),
      ...(project.bindings.kv ? [account(['kv', 'APP_CACHE'])] : []),
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
  // The Worker and every database the plan requires must be named, and no two account resources of
  // one type may share a name.
  const requiredNames = [
    deploymentPlanResourceName(current, 'worker', 'app'),
    ...[
      ...(current.project.bindings.d1 ? ['DB'] : []),
      ...(current.project.bindings.appAgent ? ['AGENT_SECURITY_DB'] : []),
    ].map((logicalName) => deploymentPlanResourceName(current, 'd1', logicalName)),
  ];
  const accountNames = APP_ACCOUNT_RESOURCES.flatMap(([type, logicalName]) =>
    current.resources
      .filter((resource) => resource.type === type && resource.logicalName === logicalName)
      .map((resource) => `${type}:${resource.proposedName}`),
  );
  return requiredNames.every(Boolean) && new Set(accountNames).size === accountNames.length;
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
