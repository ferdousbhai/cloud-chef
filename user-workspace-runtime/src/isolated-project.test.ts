import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContainerDirectoryCommand, rebaseDeploymentConfigPaths, relativeIsolatedPath } from './isolated-project';

describe('isolated project command', () => {
  it('rebases every trusted Wrangler project path into the isolated copy', () => {
    const config = rebaseDeploymentConfigPaths(
      {
        main: '/home/project/dist/server/index.js',
        assets: { directory: '/home/project/dist/client' },
        d1_databases: [
          { binding: 'DB', migrations_dir: '/home/project/migrations' },
          { binding: 'AGENT_SECURITY_DB', migrations_dir: '/home/project/agent-security-migrations' },
        ],
      },
      { projectRoot: '/home/project', isolatedRoot: '/tmp/cloudchef-projects/deployment-id' },
    );

    expect(config).toEqual({
      main: '/tmp/cloudchef-projects/deployment-id/dist/server/index.js',
      assets: { directory: '/tmp/cloudchef-projects/deployment-id/dist/client' },
      d1_databases: [
        { binding: 'DB', migrations_dir: '/tmp/cloudchef-projects/deployment-id/migrations' },
        {
          binding: 'AGENT_SECURITY_DB',
          migrations_dir: '/tmp/cloudchef-projects/deployment-id/agent-security-migrations',
        },
      ],
    });
  });

  it('enters a quoted native directory from a valid workspace cwd', () => {
    expect(
      createContainerDirectoryCommand({
        directory: '/tmp/cloudchef projects/validation-id',
        command: 'pnpm run build',
      }),
    ).toBe("cd '/tmp/cloudchef projects/validation-id' &&\npnpm run build");
  });

  it('rejects trusted deployment paths outside the durable project root', () => {
    expect(() =>
      rebaseDeploymentConfigPaths(
        { main: '/tmp/untrusted.js' },
        { projectRoot: '/home/project', isolatedRoot: '/tmp/cloudchef-projects/deployment-id' },
      ),
    ).toThrow(/outside the project root/i);
  });

  it('derives artifact paths from the requested root, not transport metadata', () => {
    expect(
      relativeIsolatedPath(
        '/tmp/cloudchef-projects/deployment-id/.cloudchef-artifact',
        '/tmp/cloudchef-projects/deployment-id/.cloudchef-artifact/index.js',
      ),
    ).toBe('index.js');
    expect(() =>
      relativeIsolatedPath(
        '/tmp/cloudchef-projects/deployment-id/.cloudchef-artifact',
        '/tmp/cloudchef-projects/deployment-id/elsewhere/index.js',
      ),
    ).toThrow(/outside its expected root/i);
  });

  it('builds one isolated artifact during validation and never hosts a preview process', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const validation = source.slice(source.indexOf('async validateTool('), source.indexOf('validationStatus('));

    expect(validation).toContain('copyProjectToIsolatedRoot(isolatedRoot, cancellation)');
    expect(validation).toContain('this.buildDeploymentArtifact({');
    expect(validation).toContain('preparedDeploymentArtifactDigest(artifact)');
    expect(validation).toContain('REVISION_CODEGEN_COMMAND.command');
    expect(validation).toContain('parallelValidationStagesCommand(PARALLEL_VALIDATION_STAGES');
    expect(validation).not.toContain('workspace.runtime.exec');
    expect(source).not.toContain('async createPreview(');
    expect(source).not.toContain('async stopPreview(');
    expect(source).not.toContain('vite preview');
    expect(source).not.toContain('trycloudflare.com');
  });

  it('drops the preview tables left behind by a workspace provisioned before this runtime', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    for (const table of [
      'cloudchef_active_preview',
      'cloudchef_pending_previews',
      'cloudchef_preview_results',
      'cloudchef_preview_cancellations',
    ]) {
      expect(source).toContain(`'${table}'`);
    }
    expect(source).toContain('DROP TABLE IF EXISTS ${table}');
  });

  it('reuses the validated artifact and rebuilds only after container loss', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const prepare = source.slice(
      source.indexOf('async prepareDeploymentArtifact('),
      source.indexOf('async deleteProject('),
    );

    expect(prepare).toContain("await activity(31, 'Reusing validated build artifact')");
    expect(prepare).toContain('(await this.exists(PREPARED_VALIDATION_ARTIFACT_ROOT)).exists');
    expect(prepare).toContain('await this.copyProjectToIsolatedRoot(PREPARED_VALIDATION_ROOT)');
    expect(prepare).toContain('expectedDigest !== observedDigest');
    expect(prepare).not.toContain('pnpm run typecheck');
    expect(prepare).not.toContain('pnpm run lint');

    // Discarding the container's copy must not discard validation's durable digest: an interrupted
    // rebuild still has to prove its bytes equal the ones validation produced.
    const discard = source.slice(
      source.indexOf('private async discardPreparedValidationArtifact('),
      source.indexOf('private async copyProjectToIsolatedRoot('),
    );
    expect(discard).not.toContain('DELETE FROM cloudchef_prepared_validation');
  });

  it('keeps the Computer container alive for stateful and deployment operations', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const deployment = source.slice(
      source.indexOf('async prepareDeploymentArtifact('),
      source.indexOf('async deleteProject('),
    );
    const statefulOperation = source.slice(
      source.indexOf('private async withStatefulOperation'),
      source.indexOf('private requireCompletedComputerSync'),
    );
    const keepAlive = source.slice(
      source.indexOf('private async withContainerKeepAlive'),
      source.indexOf('private requireCompletedComputerSync'),
    );

    expect(deployment).toContain('return await this.withContainerKeepAlive(operation)');
    expect(statefulOperation).toContain('await this.withContainerKeepAlive(() => operation(');
    expect(keepAlive).toContain('this.#containerKeepAliveOperations += 1');
    expect(keepAlive).toContain('await this.setKeepAlive(true)');
    expect(keepAlive).toContain('this.#containerKeepAliveOperations -= 1');
    expect(keepAlive).toContain("cloudchef_deployment_sessions WHERE status = 'active'");
    expect(keepAlive).toContain('this.#containerKeepAliveOperations === 0 && !deploymentActive');
    expect(keepAlive).not.toContain('activePreviewRow');
    expect(keepAlive).toContain('await this.setKeepAlive(false)');
  });

  it('starts immutable publication sessions without a container preview cleanup path', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const session = source.slice(
      source.indexOf('async beginDeploymentSession('),
      source.indexOf('async assertDeploymentSession('),
    );
    expect(session).toContain('await this.setKeepAlive(true)');
    expect(session).toContain('await this.assertDeploymentSession({ sessionId: operationId })');
    expect(session).not.toContain('cleanupPendingPreviews');
    expect(session).not.toContain('stopActivePreview');
  });

  it('publishes each durable workspace change set through one atomic VFS batch', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const applyChanges = source.slice(source.indexOf('async applyChanges('), source.indexOf('async getSyncPage('));

    expect(applyChanges).toContain('applyAtomicWorkspaceChanges(');
    expect(applyChanges).toContain('assertMutationAllowed');
    expect(applyChanges).not.toContain('workspace.fs.rm');
    expect(applyChanges).not.toContain('writeWorkspaceFile(workspace');
  });

  it('collapses repeated container schedules onto one pending row per callback', () => {
    // Container.schedule mints a fresh row id per call, so without the delete the retry sweeps
    // stack alarm rows instead of replacing the pending one.
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const scheduleOnce = source.slice(
      source.indexOf('private async scheduleOnce('),
      source.indexOf('private async cleanupReadinessRoot('),
    );

    expect(scheduleOnce).toContain('this.deleteSchedules(callback)');
    expect(scheduleOnce.indexOf('this.deleteSchedules(callback)')).toBeLessThan(
      scheduleOnce.indexOf('await this.schedule('),
    );
  });

  it('stages dependency updates away from the live project before atomic publication', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const install = source.slice(
      source.indexOf('async installDependenciesTool('),
      source.indexOf('async validateTool('),
    );

    expect(install).toContain('stagingRoot');
    expect(install).toContain('cwd: stagingRoot');
    expect(install).toContain('applyAtomicWorkspaceChanges(');
    expect(install.indexOf('requireCommandSuccess(await installation)')).toBeLessThan(
      install.indexOf('applyAtomicWorkspaceChanges('),
    );
    expect(install.indexOf('applyAtomicWorkspaceChanges(')).toBeLessThan(
      install.indexOf('this.#toolOperations.complete({ toolCallId, result })'),
    );
  });
});

describe('#139 stale-bytes guard', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('never builds from the container mount', () => {
    // The mount is the second source of truth that made #139 possible. Builds are now written out
    // of the durable VFS, so a `tar` of PROJECT_ROOT reappearing anywhere is the regression.
    expect(source).not.toContain('createIsolatedProjectCommand');
    expect(source).not.toMatch(/tar -C \$\{?shellQuote\(PROJECT_ROOT/);
    expect(source.split('await this.copyProjectToIsolatedRoot(').length - 1).toBe(2);
  });

  it('writes the isolated root from the durable VFS, one file at a time', () => {
    const helper = source.slice(
      source.indexOf('private async copyProjectToIsolatedRoot('),
      source.indexOf("   * Prove the container's own view"),
    );
    expect(helper).toContain('readProjectFilePaths');
    expect(helper).toContain('readWorkspaceFile(workspace, file.path)');
    // Bounded concurrency, because each worker holds one file and the isolate has 128 MiB.
    expect(helper).toContain('forEachConcurrently(files, MATERIALIZATION_CONCURRENCY');
    expect(helper).toContain('containerPathMatchesDurableProject');
  });

  it('compares the copy against durable truth and can force a re-materialisation', () => {
    const helper = source.slice(
      source.indexOf('private async copyProjectToIsolatedRoot('),
      source.indexOf('private async pushDurableProjectToContainer('),
    );
    expect(helper).toContain('containerPathMatchesDurableProject');
    // The retry must actually force the push; a second ordinary push would short-circuit on the
    // very `exists` check that made the stale mount look healthy.
    expect(helper).toContain('for (const forcePush of [false, true])');
    expect(helper).toContain('pushDurableProjectToContainer(forcePush)');
  });

  it("guards the model's own exec against the same stale mount, once per container generation", () => {
    // The build paths copy from the mount and verify the copy; `exec` runs against the mount
    // directly with `cwd` defaulting to PROJECT_ROOT. Without this the #139 shape survives there:
    // `read` returns the new file and `pnpm run test` runs the old one.
    expect(source.split('await this.assertContainerMatchesDurableProject();').length - 1).toBe(2);
    const guard = source.slice(
      source.indexOf('private async assertContainerMatchesDurableProject('),
      source.indexOf('private async containerPathMatchesDurableProject('),
    );
    expect(guard).toContain('this.#verifiedContainerGeneration');
    expect(guard).toContain('for (const forcePush of [false, true])');
  });

  it('does not let a present mount stand in for correct content', () => {
    const push = source.slice(
      source.indexOf('private async pushDurableProjectToContainer('),
      source.indexOf('private async runTransientCommand('),
    );
    expect(push).toContain('if (!force && (await this.exists(PROJECT_ROOT)).exists)');
  });

  it('runs every headless validation command in CI mode', () => {
    const transientCommand = source.slice(
      source.indexOf('private async runTransientCommand('),
      source.indexOf('private async terminateTransientCommand('),
    );

    expect(transientCommand).toContain("env: { CI: 'true' }");
  });
});
