import { z } from 'zod';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { isCloudChefWorkerName } from '~/lib/.server/cloudflare/project-build-plan';
import { projectBuilderDeploysWithCf } from '~/lib/.server/cloudflare/project-builder-rollout';
import { CANONICAL_ORIGIN } from '~/lib/.server/public-origin';
import { siteAllowsFraming } from '~/lib/.server/site-framing';
import { publishesAsCollaborator, recordProductionPublish } from '~/lib/cloudflare/data/org-projects.server';
import {
  claimDeployment,
  DEPLOYMENT_LEASE_MS,
  deployToWantedWorker,
  reportDeployment,
  retryDeployment,
} from '~/lib/cloudflare/data/project-deployments.server';
import { findMembership, isActiveAdmin } from '~/lib/cloudflare/data/organization-access.server';
import { json, openProject } from './runtime-projects';
import { projectPublished } from '~/lib/.server/showcase/jobs';
import { closeThreadsThatWentLive } from './threads-went-live';

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

const claimSchema = z.strictObject({
  ...projectFields,
  branch: BRANCH,
  commit: COMMIT,
  /** For a head read earlier (on opening a project): when it was read, so a newer push's claim wins. */
  headReadAt: z.number().int().positive().optional(),
  /** Whose push it is, when not the runtime's own person: whoever accepted a change someone offered. */
  pushedBy: z.string().min(1).max(128).optional(),
  /** A change someone offered: a collaborator's publish, whoever's runtime builds it. */
  asCollaborator: z.literal(true).optional(),
});
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
  step: z.enum(['preparing', 'installing', 'building', 'migrating', 'publishing']).optional(),
});
const credentialSchema = z.strictObject({
  ...projectFields,
  deploymentId: DEPLOYMENT,
  forceRefresh: z.boolean().optional(),
  /** The runtime holds this publish to what the project's Worker already uses (a collaborator's publish). */
  restricted: z.literal(true).optional(),
});

/** The project as a runtime may build and deploy it, or the refusal to answer. */
async function openDeployableProject<T extends { orgProjectId: string }>(
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
  const { project, body, identity, connection } = opened;
  const { deployment, claimed } = await claimDeployment(args.env.DB, {
    projectId: project.id,
    branch: body.branch,
    commit: body.commit,
    defaultBranch: project.defaultBranch,
    userId: identity.userId,
    // Naming who pushed can only make it a collaborator's publish, never lift that from the runtime's own person.
    restricted:
      body.asCollaborator === true ||
      (await publishesAsCollaborator(args.env.DB, project, connection.orgId, [
        identity.userId,
        ...(body.pushedBy ? [body.pushedBy] : []),
      ])),
    notBefore: body.headReadAt,
  });
  return json(
    {
      deploymentId: deployment.id,
      claimed,
      kind: deployment.kind,
      state: deployment.state,
      attempt: deployment.attempt,
      restricted: deployment.restricted,
      repo: project.repo,
      workerName: project.deployWorkerName,
      slug: project.fullName?.split('/')[1] ?? null,
      // Left out of the answer when Wrangler publishes, which is all a runtime from before `cf` knows.
      deployWith: projectBuilderDeploysWithCf(args.env, { userId: identity.userId, projectId: project.id })
        ? 'cf'
        : undefined,
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
  const { body, project, identity, connection } = opened;
  // Publishing over a Worker already in the account is for whoever runs the account (the admins of a space with
  // an account of its own), since that Worker may be any of its projects' or apps'.
  if (body.toWantedWorker) {
    const owner = isActiveAdmin(await findMembership(args.env.DB, connection.orgId, identity.userId));
    if (!owner) {
      return json({ error: 'Only the account’s admins can publish over a Worker already in the account.' }, 403);
    }
  }
  const deployment = body.toWantedWorker
    ? await deployToWantedWorker(args.env.DB, { id: body.deploymentId, projectId: project.id, userId: identity.userId })
    : await retryDeployment(args.env.DB, {
        id: body.deploymentId,
        userId: identity.userId,
        // Its creator or an admin trying a collaborator's publish again publishes it as their own.
        restricted: await publishesAsCollaborator(args.env.DB, project, connection.orgId, [identity.userId]),
      });
  if (!deployment || deployment.projectId !== project.id) {
    return json(
      {
        error: body.toWantedWorker
          ? 'That Worker can’t be used: another project publishes to it, or a newer version is being published.'
          : 'Only the newest publish that didn’t work can be tried again.',
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
  const opened = await openDeployableProject(args, reportSchema);
  if (opened instanceof Response) {
    return opened;
  }
  const { project, body, identity } = opened;
  const deployment = await args.env.DB.prepare(
    'SELECT project_id, kind, commit_sha FROM project_deployments WHERE id = ?',
  )
    .bind(body.deploymentId)
    .first<{ project_id: string; kind: 'production' | 'preview'; commit_sha: string }>();
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
    step: body.step,
  });
  // The Worker a deploy is about to write is the project's from then on, held before anything is written: another
  // CloudChef project of the connection that deploys as it already (the unique index) stops this deploy instead.
  if (outcome === 'recorded' && body.state === 'deploying' && body.workerName) {
    let reserved: boolean;
    try {
      const result = await args.env.DB.prepare(
        `UPDATE org_projects SET deploy_worker_name = ?
         WHERE id = ? AND (deploy_worker_name IS NULL OR deploy_worker_name = ?)`,
      )
        .bind(body.workerName, project.id, body.workerName)
        .run();
      reserved = result.meta.changes === 1;
    } catch (error) {
      // Only the unique Worker index means another project has it; anything else is tried again.
      if (!(error instanceof Error && error.message.includes('UNIQUE'))) {
        throw error;
      }
      reserved = false;
    }
    if (!reserved) {
      await reportDeployment(args.env.DB, {
        id: body.deploymentId,
        userId: identity.userId,
        state: 'failed',
        failureStage: 'deploy',
        reason: `Another project publishes to the Worker named ${body.workerName}.`,
      });
      return json({ outcome: 'worker_taken', workerName: null }, 200);
    }
  }
  if (outcome === 'recorded' && body.state === 'succeeded' && deployment.kind === 'production') {
    const publish = await recordProductionPublish(args.env.DB, {
      projectId: project.id,
      commit: deployment.commit_sha,
      siteUrl: body.url ?? null,
      siteFrameable: body.url ? await siteAllowsFraming(body.url, CANONICAL_ORIGIN) : null,
      publishedAt: Date.now(),
    });
    // A public project's post is made or updated with it (app/lib/.server/showcase/jobs.ts), and its threads waiting
    // for a change this commit holds close (threads-went-live.ts).
    if (publish) {
      await projectPublished(args.env, publish);
      await closeThreadsThatWentLive(args.request, args.env, {
        projectId: project.id,
        connectionId: project.connectionId,
        commit: publish.commit,
        reportedBy: identity.userId,
        at: publish.publishedAt,
      });
    }
  }
  // The Worker the project deploys as now, which a deploy that just started (or started over) uses.
  const held = await args.env.DB.prepare('SELECT deploy_worker_name FROM org_projects WHERE id = ?')
    .bind(project.id)
    .first<{ deploy_worker_name: string | null }>();
  return json({ outcome, workerName: held?.deploy_worker_name ?? null }, 200);
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
    `SELECT restricted FROM project_deployments
     WHERE id = ? AND project_id = ? AND claimed_by = ? AND state = 'deploying' AND lease_expires_at > ?`,
  )
    .bind(body.deploymentId, project.id, identity.userId, Date.now())
    .first<{ restricted: number }>();
  if (!live) {
    return json({ error: 'Nothing of this project is being deployed by this workspace now.' }, 409);
  }
  // A collaborator's publish gets the token only from a runtime that holds it to the project's own resources: one
  // from before that rule asks without saying so, and is refused until it has upgraded.
  if (live.restricted === 1 && body.restricted !== true) {
    return json({ error: 'This workspace is being upgraded. Publish again in a few minutes.' }, 409);
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
