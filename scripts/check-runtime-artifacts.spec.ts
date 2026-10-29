import { describe, expect, it, vi } from 'vitest';

import { checkRuntimeArtifacts, errorReport, parseRuntimeArtifactPins } from './check-runtime-artifacts.mjs';

const computerdDigest = `sha256:${'a'.repeat(64)}`;
const sandboxDigest = `sha256:${'b'.repeat(64)}`;
const nodeDigest = `sha256:${'c'.repeat(64)}`;

function pins(computerTag = '0.8.0') {
  return parseRuntimeArtifactPins({
    packageJson: JSON.stringify({
      dependencies: { '@cloudflare/sandbox': '1.0.3', '@cloudflare/computer': '0.8.0' },
    }),
    dockerfile: [
      `ARG NODE_IMAGE=docker.io/library/node:26.3.0-trixie-slim@${nodeDigest}`,
      `ARG COMPUTERD_IMAGE=ghcr.io/cloudflare/computer-computerd-linux-x64:${computerTag}@${computerdDigest}`,
      `ARG SANDBOX_SHIM_IMAGE=docker.io/cloudflare/sandbox:1.0.3@${sandboxDigest}`,
    ].join('\n'),
  });
}

function registryFetch(published: { computerd?: string; sandbox?: string; node?: string } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/token?')) {
      return Response.json({ token: 'registry-token' });
    }
    const digest = url.includes('computerd')
      ? (published.computerd ?? computerdDigest)
      : url.includes('cloudflare/sandbox')
        ? (published.sandbox ?? sandboxDigest)
        : (published.node ?? nodeDigest);
    return Response.json({ schemaVersion: 2 }, { headers: { 'docker-content-digest': digest } });
  });
}

describe('runtime artifact monitoring', () => {
  it('reads every base of the workspace image, with the SDK versions as the vendor tags', () => {
    expect(pins()).toEqual([
      {
        name: 'Cloudflare computerd image',
        host: 'ghcr.io',
        repository: 'cloudflare/computer-computerd-linux-x64',
        tag: '0.8.0',
        configuredTag: '0.8.0',
        pinnedDigest: computerdDigest,
      },
      {
        name: 'Cloudflare Sandbox image (sandbox-shim)',
        host: 'docker.io',
        repository: 'cloudflare/sandbox',
        tag: '1.0.3',
        configuredTag: '1.0.3',
        pinnedDigest: sandboxDigest,
      },
      {
        name: 'Node.js base image',
        host: 'docker.io',
        repository: 'library/node',
        tag: '26.3.0-trixie-slim',
        configuredTag: '26.3.0-trixie-slim',
        pinnedDigest: nodeDigest,
      },
    ]);
  });

  it('reports current pins when every published tag still resolves to its digest', async () => {
    const fetchImpl = registryFetch();
    const result = await checkRuntimeArtifacts(pins(), fetchImpl);

    expect(result.status).toBe('current');
    expect(result.results).toHaveLength(3);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('reports digest drift without hiding the published replacements', async () => {
    const published = `sha256:${'d'.repeat(64)}`;
    const result = await checkRuntimeArtifacts(pins(), registryFetch({ computerd: published }));

    expect(result.status).toBe('drift');
    expect(result.results[0]).toMatchObject({ remoteDigest: published, status: 'drift' });
    expect(result.markdown).toContain('Runtime artifact pins need attention');
  });

  it('reports a vendor base whose tag no longer matches its package', async () => {
    const result = await checkRuntimeArtifacts(pins('0.6.0'), registryFetch());

    expect(result.status).toBe('drift');
    expect(result.results[0]?.detail).toContain('does not match the package 0.8.0');
  });

  it('renders operational failures for the same tracking issue', () => {
    const result = errorReport(new Error('registry unavailable'));

    expect(result.status).toBe('error');
    expect(result.markdown).toContain('registry unavailable');
  });
});
