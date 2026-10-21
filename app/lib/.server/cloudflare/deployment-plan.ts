import { sha256Hex } from '~/lib/hex-digest';
import { z } from 'zod';
import { appResourceName, type AppResourceLogicalName } from '~/lib/cloudflare/app-resource-names';
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

/**
 * The account resources a plan may name, as (type, logical name): the ones a deployment or a preview
 * creates. A preview publishes to a Worker, databases, bucket and namespace of its own, so nothing it
 * runs reaches production's.
 */
export const APP_ACCOUNT_RESOURCES = [
  ['worker', 'app'],
  ['worker', 'app_preview'],
  ['d1', 'DB'],
  ['d1', 'DB_PREVIEW'],
  ['d1', 'AGENT_SECURITY_DB'],
  ['d1', 'AGENT_SECURITY_DB_PREVIEW'],
  ['kv', 'APP_CACHE'],
  ['kv', 'APP_CACHE_PREVIEW'],
  ['r2', 'APP_STORAGE'],
  ['r2', 'APP_STORAGE_PREVIEW'],
] as const satisfies readonly (readonly [DeploymentResourceType, AppResourceLogicalName])[];

type AppAccountResource = (typeof APP_ACCOUNT_RESOURCES)[number];

/** An account resource the project's deployments already use, by the name one of them gave it. */
export type AdoptedDeploymentResource = { type: AppAccountResource[0]; logicalName: string; name: string };

/**
 * How a project's plans name its account resources: as its earlier deployments already do, and
 * otherwise after the project's own identity, so every revision of it names the same ones.
 */
export type DeploymentResourceNaming = {
  identity: string;
  adopted: readonly AdoptedDeploymentResource[];
};

function projectResourceName(naming: DeploymentResourceNaming, [type, logicalName]: AppAccountResource): string {
  return (
    naming.adopted.find((resource) => resource.type === type && resource.logicalName === logicalName)?.name ??
    appResourceName(naming.identity, logicalName)
  );
}

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
    proposedName: projectResourceName(args.naming, resource),
  });
  const plan: DeploymentPlan = {
    version: DEPLOYMENT_PLAN_VERSION,
    deploymentId: args.deploymentId,
    sourceSha256: args.sourceSha256,
    project,
    resources: [
      account(['worker', 'app']),
      account(['worker', 'app_preview']),
      ...(project.bindings.d1 ? [account(['d1', 'DB']), account(['d1', 'DB_PREVIEW'])] : []),
      ...(project.bindings.appAgent
        ? [account(['d1', 'AGENT_SECURITY_DB']), account(['d1', 'AGENT_SECURITY_DB_PREVIEW'])]
        : []),
      ...(project.bindings.r2 ? [account(['r2', 'APP_STORAGE']), account(['r2', 'APP_STORAGE_PREVIEW'])] : []),
      ...(project.bindings.kv ? [account(['kv', 'APP_CACHE']), account(['kv', 'APP_CACHE_PREVIEW'])] : []),
      ...(project.bindings.appAgent
        ? [{ type: 'durable_object' as const, logicalName: 'AppAgent', proposedName: 'AppAgent' }]
        : []),
      ...(project.bindings.ai ? [{ type: 'workers_ai' as const, logicalName: 'AI', proposedName: 'AI' }] : []),
    ],
  };
  const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify(plan)));
  return { plan, digest };
}

/**
 * Whether every account resource the plan names is the one the project's resources are named now. A
 * plan made before the project settled on them, when each deployment named its own, would publish to
 * an empty database at a new address.
 */
export function planNamesProjectResources(plan: DeploymentPlan, naming: DeploymentResourceNaming): boolean {
  return APP_ACCOUNT_RESOURCES.every((resource) =>
    plan.resources
      .filter((planned) => planned.type === resource[0] && planned.logicalName === resource[1])
      .every((planned) => planned.proposedName === projectResourceName(naming, resource)),
  );
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
  // Every database the plan requires must be named, and no two account resources of one type may
  // share a name: a preview that resolved to production's database, bucket or Worker would write to
  // it. A plan made before previews had a Worker of their own names none, and only deploys.
  const databaseNames = [
    ...(current.project.bindings.d1 ? ['DB', 'DB_PREVIEW'] : []),
    ...(current.project.bindings.appAgent ? ['AGENT_SECURITY_DB', 'AGENT_SECURITY_DB_PREVIEW'] : []),
  ].map((logicalName) => deploymentPlanResourceName(current, 'd1', logicalName));
  const accountNames = APP_ACCOUNT_RESOURCES.flatMap(([type, logicalName]) =>
    current.resources
      .filter((resource) => resource.type === type && resource.logicalName === logicalName)
      .map((resource) => `${type}:${resource.proposedName}`),
  );
  return databaseNames.every(Boolean) && new Set(accountNames).size === accountNames.length;
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
