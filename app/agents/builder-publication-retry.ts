import { z } from 'zod';

/** Why a new turn stopped the automatic publication it found running. */
export class PublicationSupersededError extends Error {
  constructor() {
    super('A newer turn superseded this publication; the latest revision publishes when that turn ends.');
    this.name = 'PublicationSupersededError';
  }
}

/** How long after each failed attempt an automatic deployment tries again; past the last, it waits for the next turn. */
export const AUTOMATIC_DEPLOYMENT_RETRY_DELAYS_SECONDS = [30, 120, 480] as const;

/** A scheduled retry names the exact checkpoint that failed and how many retries came before it. */
export const automaticDeploymentRetrySchema = z.object({
  workspaceRevision: z.number().int().min(0),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  attempt: z.number().int().min(1).max(AUTOMATIC_DEPLOYMENT_RETRY_DELAYS_SECONDS.length),
});
export type AutomaticDeploymentRetry = z.infer<typeof automaticDeploymentRetrySchema>;

/**
 * What a failed deployment says about itself, read where it was caught: its message, and whether the
 * Durable Object that failed marked the failure retryable.
 */
export type DeploymentFailure = { message: string; retryable: boolean };

/**
 * Failures that say nothing about the app: the workspace or another deployment of the project was
 * busy, the Durable Object or the deployment was interrupted, or the credential broker could not be
 * reached. A failed build, a project that changed, or a refusal is the same on every attempt, so it
 * waits for the next turn instead.
 */
const PASSING_FAILURE_MESSAGES = [
  'Finish the active deployment before starting another one.',
  'Deployment was interrupted.',
  'Interrupted deployment recovery is pending.',
  'Cloudflare connection is unavailable.',
  'The project workspace is busy with',
  '[workspace_operation_conflict]',
  'fetch failed',
  'Network connection lost',
];

export function isPassingDeploymentFailure(failure: DeploymentFailure): boolean {
  return failure.retryable || PASSING_FAILURE_MESSAGES.some((passing) => failure.message.includes(passing));
}

/** The retry that follows a failed automatic deployment, or null when it should not be retried. */
export function nextAutomaticDeploymentRetry(
  failed: { workspaceRevision: number; revision: string; attempt: number },
  failure: DeploymentFailure,
): { retry: AutomaticDeploymentRetry; delaySeconds: number } | null {
  const delaySeconds = AUTOMATIC_DEPLOYMENT_RETRY_DELAYS_SECONDS[failed.attempt];
  if (delaySeconds === undefined || !isPassingDeploymentFailure(failure)) {
    return null;
  }
  return {
    retry: { workspaceRevision: failed.workspaceRevision, revision: failed.revision, attempt: failed.attempt + 1 },
    delaySeconds,
  };
}
