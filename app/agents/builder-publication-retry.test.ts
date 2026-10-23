import { describe, expect, it } from 'vitest';
import { nextAutomaticDeploymentRetry } from './builder-publication-retry';

const failed = { workspaceRevision: 3, revision: 'a'.repeat(64) };
const retries = (failure: { message: string; retryable: boolean }) =>
  nextAutomaticDeploymentRetry({ ...failed, attempt: 0 }, failure) !== null;

describe('automatic deployment retries', () => {
  it.each([
    'Finish the active deployment before starting another one.',
    'Deployment was interrupted. Retry to reconcile the exact revision.',
    'Cloudflare connection is unavailable.',
    'The project workspace is busy with deployment. Retry in 60 seconds.',
    '[workspace_operation_conflict] validate is running; retry after 1000ms.',
  ])('retries a failure that says nothing about the app: %s', (message) => {
    expect(retries({ message, retryable: false })).toBe(true);
  });

  it.each([
    'The build failed: typecheck reported 2 errors.',
    'The project changed after the deployment was requested. Build the current revision instead.',
    'This member works on GitHub projects only.',
  ])('leaves a failure that would repeat for the next turn: %s', (message) => {
    expect(retries({ message, retryable: false })).toBe(false);
  });

  it('retries a failure the Durable Object marked retryable', () => {
    expect(retries({ message: 'Durable Object reset.', retryable: true })).toBe(true);
  });

  it('backs off between attempts and stops after the last one', () => {
    const busy = { message: 'Finish the active deployment before starting another one.', retryable: false };
    expect(nextAutomaticDeploymentRetry({ ...failed, attempt: 0 }, busy)).toEqual({
      retry: { ...failed, attempt: 1 },
      delaySeconds: 30,
    });
    expect(nextAutomaticDeploymentRetry({ ...failed, attempt: 2 }, busy)?.delaySeconds).toBe(480);
    expect(nextAutomaticDeploymentRetry({ ...failed, attempt: 3 }, busy)).toBeNull();
  });
});
