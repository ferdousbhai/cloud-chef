import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('deployment credential boundary', () => {
  it('keeps provider credentials out of ProjectWorkspace input and every untrusted build command environment', () => {
    const executorSource = readFileSync(new URL('./user-workspace-deployment-executor.ts', import.meta.url), 'utf8');
    const inputStart = executorSource.indexOf('prepareDeploymentArtifact({');
    const inputEnd = executorSource.indexOf('}),\n    { revision:', inputStart);
    expect(inputStart).toBeGreaterThan(0);
    expect(inputEnd).toBeGreaterThan(inputStart);
    const projectInput = executorSource.slice(inputStart, inputEnd);
    expect(projectInput).not.toMatch(/accessToken|apiToken|CONTROL_PLANE_SECRET|authorization/i);

    const runtimeSource = readFileSync(
      new URL('../../../../user-workspace-runtime/src/index.ts', import.meta.url),
      'utf8',
    );
    const methodStart = runtimeSource.indexOf('async prepareDeploymentArtifact(');
    const methodEnd = runtimeSource.indexOf('async deleteProject(', methodStart);
    expect(methodStart).toBeGreaterThan(0);
    expect(methodEnd).toBeGreaterThan(methodStart);
    const preparation = runtimeSource.slice(methodStart, methodEnd);
    const buildStart = runtimeSource.indexOf('private async buildDeploymentArtifact(');
    const buildEnd = runtimeSource.indexOf('private async collectDeploymentArtifact(', buildStart);
    const build = runtimeSource.slice(buildStart, buildEnd);
    expect(build).toContain('cf deploy --prebuilt --mode production --dry-run');
    // Materialisation now goes through the verified copy, which pushes and then proves the
    // isolated root matches the durable VFS before anything is built from it (#139).
    expect(preparation).toContain('await this.copyProjectToIsolatedRoot(PREPARED_VALIDATION_ROOT)');
    expect(preparation).toContain('await this.runTransientCommand(');
    expect(preparation).not.toMatch(/apiToken|CLOUDFLARE_API_TOKEN|authorization|env\s*:/i);

    const transientCommandStart = runtimeSource.indexOf('private async runTransientCommand(');
    const transientCommandEnd = runtimeSource.indexOf(
      'private async recycleWorkspaceContainer(',
      transientCommandStart,
    );
    expect(transientCommandStart).toBeGreaterThan(0);
    expect(transientCommandEnd).toBeGreaterThan(transientCommandStart);
    const transientCommand = runtimeSource.slice(transientCommandStart, transientCommandEnd);
    expect(transientCommand).toContain('runTrackedSandboxCommand');
    expect(transientCommand).toContain(
      "this.containerProcesses.exec(trackedCommand, { ...options, env: { CI: 'true', ...CONTAINER_COMMAND_ENV } })",
    );
    expect(transientCommand).not.toMatch(/apiToken|CLOUDFLARE_API_TOKEN|authorization/i);
    expect(runtimeSource).not.toContain("route.operation === 'deploy'");
  });
});
