import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isPublishedLock, workspaceImagePinErrors, workspaceImageTag } from './publish-user-workspace-image.mjs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function sources() {
  return {
    dockerfile: read('user-workspace-image/Dockerfile'),
    packageJson: read('package.json'),
    nvmrc: read('.nvmrc'),
    templatePackageJson: read('template/package.json'),
    computerSource: read('cloudchef-agent/cloudflare-computer.ts'),
  };
}

describe('workspace image', () => {
  it('pins computerd and sandbox-shim to the package versions that speak their protocols, and the toolchain to its pins', () => {
    expect(workspaceImagePinErrors(sources())).toEqual([]);
  });

  it('names each base that drifted from this checkout', () => {
    const drifted = { ...sources() };
    drifted.packageJson = JSON.stringify({
      dependencies: { '@cloudflare/computer': '0.9.0', '@cloudflare/sandbox': '1.0.3' },
    });
    drifted.dockerfile = drifted.dockerfile.replace(/^ARG PNPM_VERSION=.*$/m, 'ARG PNPM_VERSION=1.0.0');

    const errors = workspaceImagePinErrors(drifted);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('computer-computerd-linux-x64:0.9.0');
    expect(errors[1]).toContain('PNPM_VERSION');
  });

  it('starts computerd as its entrypoint', () => {
    const withoutEntrypoint = { ...sources() };
    withoutEntrypoint.dockerfile = withoutEntrypoint.dockerfile.replace(/^ENTRYPOINT .*$/m, '');
    expect(workspaceImagePinErrors(withoutEntrypoint)).toEqual(['The image must start computerd as its entrypoint.']);
  });

  it('tags a build by its vendor versions and context, so a changed context never overwrites a tag', () => {
    const packageJson = JSON.stringify({
      dependencies: { '@cloudflare/computer': '0.8.0', '@cloudflare/sandbox': '1.0.3' },
    });
    const tag = workspaceImageTag({ packageJson, context: { Dockerfile: 'a', 'tmux.conf': 'b' } });

    expect(tag).toMatch(/^computer-0\.8\.0-sandbox-1\.0\.3-[a-f0-9]{12}$/);
    expect(workspaceImageTag({ packageJson, context: { 'tmux.conf': 'b', Dockerfile: 'a' } })).toBe(tag);
    expect(workspaceImageTag({ packageJson, context: { Dockerfile: 'a2', 'tmux.conf': 'b' } })).not.toBe(tag);
  });

  it('counts only a lock with a repository, a tag and a digest as published', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(isPublishedLock({ repository: 'docker.io/x/y', tag: 't', digest })).toBe(true);
    expect(isPublishedLock({ repository: 'docker.io/x/y', tag: '', digest: '' })).toBe(false);
    expect(isPublishedLock({ repository: 'docker.io/x/y', tag: 't', digest: 'sha256:short' })).toBe(false);
    expect(isPublishedLock({ repository: '', tag: 't', digest })).toBe(false);
  });
});
