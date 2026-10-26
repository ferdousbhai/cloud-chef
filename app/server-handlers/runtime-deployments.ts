import { z } from 'zod';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { isCloudChefWorkerName } from '~/lib/.server/cloudflare/project-build-plan';
import { CANONICAL_ORIGIN } from '~/lib/.server/public-origin';
import { siteAllowsFraming } from '~/lib/.server/site-framing';
import { recordProjectSiteUrl } from '~/lib/cloudflare/data/org-projects.server';
import {
  claimDeployment,
  DEPLOYMENT_LEASE_MS,
  deployToWantedWorker,
  reportDeployment,
  retryDeployment,
} from '~/lib/cloudflare/data/project-deployments.server';
import { json, openProject } from './runtime-projects';

/**
 * A member's workspace runtime building and deploying a project CloudChef deploys itself (one uploaded as a ZIP):
 * it claims a commit, reports each step, and asks for the account's Cloudflare authorization only while its claimed
 * deploy step runs. Every call re-checks that the person may edit the project in the connection the runtime runs for.
 */
const COMMIT = z.string().regex(/^[0-9a-f]{40}$/);
const BRANCH = z
  .string()
  .regex(/^[A-Za-z0-9._/-]{1,255}$/)
  .refine((branch) => !branch.includes('..'));
const DEPLOYMENT = z.string().uuid();
const projectFields = { orgProjectId: z.string().uuid() };

const claimSchema = z.strictObject({ ...projectFields, branch: BRANCH, commit: COMMIT });
const retrySchema = z.strictObject({
  ...projectFields,
  deploymentId: DEPLOYMENT,
  /** Deploy it again to the Worker its config names, which was taken, replacing what that Worker runs. */
  toWantedWorker: z.literal(true).optional(),
});
const WORKER_NAME = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const reportSchema = z.strictObject({
  ...projectFields,
  deploymentId: DEPLOYMENT,
  state: z.enum(['building', 'deploying', 'succeeded', 'failed', 'not_deployable']),
  failureStage: z.enum(['config', 'install', 'build', 'migrations', 'deploy', 'interrupted']).optional(),
  reason: z.string().max(1_000).optional(),
  url: z.url({ protocol: /^https$/ }).optional(),
  workerName: WORKER_NAME.optional(),
  wantedWorkerName: WORKER_NAME.refine((name) => !isCloudChefWorkerName(name)).optional(),
});
const credentialSchema = z.strictObject({
  ...projectFields,
  deploymentId: DEPLOYMENT,
  forceRefresh: z.boolean().optional(),
});

/** The project as a runtime may build and deploy it, or the refusal to answer. */
async function openDeployableProject<T extends z.infer<typeof retrySchema> | z.infer<typeof claimSchema>>(
  args: { request: Request; env: Env },
  schema: z.ZodType<T>,
) {
  const opened = await openProject(args, schema);
  if (opened instanceof Response) {
    return opened;
  }
  if (opened.project.role !== 'edit') {
    return json({ error: 'You can view this project but not publish it.' }, 403);
  }
  if (opened.project.deploysWith !== 'cloudchef' || opened.project.workersBuildsScriptTag !== null) {
    return json({ error: 'Workers Builds publishes this project, not CloudChef.', code: 'workers_builds' }, 409);
  }
  if (opened.project.repo === null) {
    return json({ error: 'This project has no code yet.' }, 409);
  }
  return opened;
}

/** `runtime-projects/deployments/claim`: builds and deploys this commit of this branch, exactly once. */
export async function runtimeDeploymentClaimAction(args: { request: Request; env: Env }): Promise<Response> {
  const opened = await openDeployableProject(args, claimSchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { project, body, identity } = opened;
  const { deployment, claimed } = await claimDeployment(args.env.DB, {
    projectId: project.id,
    branch: body.branch,
    commit: body.commit,
    defaultBranch: project.defaultBranch,
    userId: identity.userId,
  });
  return json(
    {
      deploymentId: deployment.id,
      claimed,
      kind: deployment.kind,
      state: deployment.state,
      attempt: deployment.attempt,
      repo: project.repo,
      workerName: project.deployWorkerName,
    },
    200,
  );
}

/**
 * `runtime-projects/deployments/retry`: a failed deployment, started again as a new attempt; or a succeeded one that
 * went to a derived Worker name, deployed again to the Worker its config names.
 */
export async function runtimeDeploymentRetryAction(args: { request: Request; env: Env }): Promise<Response> {
  const opened = await openDeployableProject(args, retrySchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { body, project, identity } = opened;
  const deployment = body.toWantedWorker
    ? await deployToWantedWorker(args.env.DB, { id: body.deploymentId, projectId: project.id, userId: identity.userId })
    : await retryDeployment(args.env.DB, { id: body.deploymentId, userId: identity.userId });
  if (!deployment || deployment.projectId !== project.id) {
    return json(
      {
        error: body.toWantedWorker
          ? 'That Worker can’t be used: another project publishes to it, or a newer version is being published.'
          : 'Only the newest failed deploy can be tried again.',
      },
      409,
    );
  }
  return json(
    {
      deploymentId: deployment.id,
      kind: deployment.kind,
      branch: deployment.branch,
      commit: deployment.commit,
      attempt: deployment.attempt,
    },
    200,
  );
}

/**
 * `runtime-projects/deployments/report`: a step of a claimed deployment, or how it ended. A production deploy that
 * succeeded is the project's live site from then on, and the Worker it went to is the one it deploys as.
 */
export async function runtimeDeploymentReportAction(args: { request: Request; env: Env }): Promise<Response> {
  const opened = await openProject(args, reportSchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { project, body, identity } = opened;
  if (project.deploysWith !== 'cloudchef') {
    return json({ error: 'Workers Builds publishes this project, not CloudChef.', code: 'workers_builds' }, 409);
  }
  const deployment = await args.env.DB.prepare('SELECT project_id, kind FROM project_deployments WHERE id = ?')
    .bind(body.deploymentId)
    .first<{ project_id: string; kind: 'production' | 'preview' }>();
  if (deployment?.project_id !== project.id) {
    return json({ error: 'That deployment is not this project’s.' }, 404);
  }
  const outcome = await reportDeployment(args.env.DB, {
    id: body.deploymentId,
    userId: identity.userId,
    state: body.state,
    failureStage: body.failureStage,
    reason: body.reason,
    url: body.url,
    workerName: body.workerName,
    wantedWorkerName: body.wantedWorkerName,
  });
  if (outcome === 'recorded' && body.state === 'succeeded' && deployment.kind === 'production') {
    if (body.workerName) {
      await args.env.DB.prepare(
        'UPDATE org_projects SET deploy_worker_name = ? WHERE id = ? AND deploy_worker_name IS NULL',
      )
        .bind(body.workerName, project.id)
        .run()
        .catch(() => undefined);
    }
    if (body.url) {
      await recordProjectSiteUrl(args.env.DB, project.id, {
        url: body.url,
        frameable: await siteAllowsFraming(body.url, CANONICAL_ORIGIN),
      });
    }
  }
  return json({ outcome }, 200);
}

/**
 * `runtime-projects/deployments/credential`: the account's Cloudflare authorization, for the deploy step of a
 * deployment this runtime claimed and is deploying under a live lease, and at no other time. It works for a team
 * member who may only work on team projects too: the token is for publishing this project, as a push to main does.
 */
export async function runtimeDeploymentCredentialAction(args: { request: Request; env: Env }): Promise<Response> {
  const opened = await openDeployableProject(args, credentialSchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { project, body, identity, credentialHandle } = opened;
  const live = await args.env.DB.prepare(
    `SELECT 1 FROM project_deployments
     WHERE id = ? AND project_id = ? AND claimed_by = ? AND state = 'deploying' AND lease_expires_at > ?`,
  )
    .bind(body.deploymentId, project.id, identity.userId, Date.now())
    .first();
  if (!live) {
    return json({ error: 'Nothing of this project is being deployed by this workspace now.' }, 409);
  }
  try {
    const accessToken = await D1CloudflareCredentialVault.fromEnv(args.env).resolve(credentialHandle, {
      forceRefresh: 'forceRefresh' in body && body.forceRefresh === true,
    });
    return json({ accessToken, expiresWithin: DEPLOYMENT_LEASE_MS }, 200);
  } catch {
    console.error('Unable to resolve the deploy credential');
    return json({ error: 'The Cloudflare connection is unavailable.' }, 503);
  }
}
