import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('BuilderAgent preview lifecycle', () => {
  const source = readFileSync(new URL('./builder-agent.ts', import.meta.url), 'utf8');

  it('cancels background preview work before a foreground user turn', () => {
    const chatMessage = source.slice(
      source.indexOf('override async onChatMessage('),
      source.indexOf('private async runContextCompaction('),
    );

    const foregroundGuard = chatMessage.indexOf('if (!options?.continuation) {');
    const previewCancellation = chatMessage.indexOf('await this.cancelPreview()');
    expect(foregroundGuard).toBeGreaterThanOrEqual(0);
    expect(previewCancellation).toBeGreaterThan(foregroundGuard);
    expect(previewCancellation).toBeLessThan(chatMessage.indexOf('const turn = createBuilderTurn'));
  });

  it('publishes the hosted preview for validated work first and deploys behind it', () => {
    const response = source.slice(
      source.indexOf('protected override async onChatResponse('),
      source.indexOf('@callable()\n  async steerActiveTurn'),
    );
    const preview = source.slice(
      source.indexOf('private async requestPreviewInternal('),
      source.indexOf('private async runPreviewPublication('),
    );
    const publication = source.slice(
      source.indexOf('private async runPreviewPublication('),
      source.indexOf('private async failPreviewPublication('),
    );

    expect(response).toContain('const validatedSnapshot = await this.refreshDeploymentReadiness()');
    expect(response).toContain('await this.publishValidatedRevision(validatedSnapshot)');
    expect(response).not.toContain('this.scheduleDeployment(validatedSnapshot)');
    expect(source).toContain('this.requestPreviewInternal({ validatedSnapshot: snapshot, autoDeploy: true })');
    // Only the validated-revision pipeline deploys behind the preview. A manual "Build preview"
    // request must never promote to the public production URL.
    expect(source).toContain('return this.requestPreviewInternal({ autoDeploy: false })');
    // Deployment follows the settled pipeline preview on both the success and the failure path, so a
    // broken preview can never cost the user the production deployment — but only behind the
    // autoDeploy guard, so a manual "Build preview" never promotes to production.
    expect(publication.match(/await this\.schedulePipelineDeploymentAfterPreview\(job\)/g)).toHaveLength(2);
    expect(source).toContain('private async schedulePipelineDeploymentAfterPreview(job: PreviewPublicationJob)');
    expect(source).toContain('if (job.autoDeploy)');
    // And a successful deployment no longer gates the preview: the old post-deployment preview
    // trigger stays deleted.
    expect(source).not.toContain('this.requestPreviewInternal({ validatedSnapshot: job })');
    expect(preview).toContain('options.validatedSnapshot ?? (await this.workspace.checkpoint())');
    expect(source).toContain('validatePreviewCheckpointForBuilder(validationRequest)');
    expect(source).toContain('await this.runPreviewPublication(job, fiber.signal)');
  });

  it('revokes preview ownership before cancelling a fiber so recovered work cannot publish', () => {
    const cancellation = source.slice(
      source.indexOf('async cancelPreview()'),
      source.indexOf('@callable()\n  async getTranscriptSnapshot'),
    );

    expect(cancellation.indexOf('this.setPreviewState(next)')).toBeLessThan(
      cancellation.indexOf('await this.cancelFiberByKey'),
    );
  });

  it('persists requested runtime compaction only after the completed response', () => {
    const chatMessage = source.slice(
      source.indexOf('override async onChatMessage('),
      source.indexOf('private async scheduleContextCompaction('),
    );
    const response = source.slice(
      source.indexOf('protected override async onChatResponse('),
      source.indexOf('@callable()\n  async steerActiveTurn'),
    );

    expect(chatMessage).toContain('requestDurableCompaction: () =>');
    expect(response).toContain('const compactAfterTurn =');
    expect(response).toContain('this.scheduleContextCompaction(throughMessageId, this.messages.length, credentials)');
    expect(response.indexOf('await this.advanceTranscriptCheckpoint')).toBeLessThan(
      response.indexOf('this.scheduleContextCompaction'),
    );
  });

  it('terminalizes an interrupted deployment again before admitting a manual retry', () => {
    const retry = source.slice(
      source.indexOf('async deployValidatedRevision()'),
      source.indexOf('@callable()\n  requestPreview'),
    );

    expect(retry).toContain("current.status === 'failed'");
    expect(retry).toContain('await this.terminalizeDeployment(snapshot)');
    expect(retry.indexOf('terminalizeDeployment')).toBeLessThan(retry.indexOf('scheduleDeployment'));
  });

  it('keeps the agent alive while stateful Computer tools run', () => {
    const chatMessage = source.slice(
      source.indexOf('override async onChatMessage('),
      source.indexOf('private async runContextCompaction('),
    );

    expect(chatMessage).toContain('runWithKeepAlive: (operation) => this.keepAliveWhile(operation)');
  });

  it('publishes the validated revision through the shared account deployment path', () => {
    const publication = source.slice(
      source.indexOf('private async runPreviewPublication('),
      source.indexOf('private async failPreviewPublication('),
    );

    expect(publication).toContain('previewValidatedRevisionForBuilder({');
    expect(publication).toContain('validatedRevision: validatedSnapshot.revision');
    expect(publication).toContain('if (!this.isCurrentPreviewJob(job.previewId))');
    expect(publication).not.toContain('this.workspace.createPreview');
    // The preview names the deployment's own tool-call identity, so both resolve to one plan and
    // one Worker rather than the preview publishing resources of its own.
    expect(publication).toContain('toolCallId: deploymentToolCallId(job.workspaceRevision, job.snapshotRevision)');
    expect(source).toContain('toolCallId: deploymentToolCallId(job.workspaceRevision, job.revision)');
  });

  it('never lets a preview stand in for deployment evidence', () => {
    const deploy = source.slice(
      source.indexOf('async deployValidatedRevision()'),
      source.indexOf('@callable()\n  requestPreview'),
    );

    expect(deploy).toContain('await validatedDeploymentCheckpoint(this.workspace)');
    expect(deploy).not.toContain('preview');
    expect(deploy).not.toContain('Preview');
  });

  it('cancels active validation before waiting for a stopped turn to settle', () => {
    const cancellation = source.slice(
      source.indexOf('async cancelActiveTurn()'),
      source.indexOf('@callable()\n  getWorkspaceState'),
    );
    const boundedCancellation = 'await waitForCancellationBeforeDeadline(validationCancellation, deadline)';

    expect(cancellation).toContain('const validationCancellation = this.workspace.cancelActiveValidation()');
    expect(cancellation.indexOf('this.abortAllRequests(')).toBeLessThan(cancellation.indexOf(boundedCancellation));
    expect(cancellation.indexOf(boundedCancellation)).toBeLessThan(cancellation.indexOf('await this.waitUntilStable('));
    expect(cancellation).toContain('const deadline = Date.now() + CHAT_CANCELLATION_SETTLE_TIMEOUT_MS');
    expect(cancellation).toContain('const remainingSettleTime = Math.max(0, deadline - Date.now())');
    expect(cancellation).toContain('timeout: remainingSettleTime');
  });
});
