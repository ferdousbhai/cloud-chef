import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { checkRuntimeArtifacts, errorReport, parseRuntimeArtifactPins } from './check-runtime-artifacts.mjs';

const layerDigest = `sha256:${'a'.repeat(64)}`;
const nodeSum = 'b'.repeat(64);

function baseSource(computerd = '0.8.0') {
  return [
    "export const BASE_NODE_VERSION = '26.3.0';",
    `const BASE_NODE_SHA256 = '${nodeSum}';`,
    `export const BASE_COMPUTERD_VERSION = '${computerd}';`,
    "const BASE_COMPUTERD_REPOSITORY = 'cloudflare/computer-computerd-linux-x64';",
    `const BASE_COMPUTERD_LAYER_DIGEST = '${layerDigest}';`,
  ].join('\n');
}

function pins(computerd = '0.8.0') {
  return parseRuntimeArtifactPins({
    packageJson: JSON.stringify({ dependencies: { '@cloudflare/computer': '0.8.0' } }),
    baseSource: baseSource(computerd),
  });
}

function publishedFetch(published: { layers?: string[]; nodeSum?: string } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/token?')) {
      return Response.json({ token: 'registry-token' });
    }
    if (url.endsWith('/SHASUMS256.txt')) {
      return new Response(
        `${'c'.repeat(64)}  node-v26.3.0-darwin-arm64.tar.xz\n${published.nodeSum ?? nodeSum}  node-v26.3.0-linux-x64.tar.xz\n`,
      );
    }
    return Response.json({
      schemaVersion: 2,
      layers: (published.layers ?? [layerDigest]).map((digest) => ({ digest })),
    });
  });
}

describe('runtime artifact monitoring', () => {
  it('reads the base setup’s downloads, with the Computer package version as computerd’s tag', () => {
    expect(pins()).toEqual([
      {
        kind: 'ghcr-layer',
        name: 'Cloudflare computerd layer',
        repository: 'cloudflare/computer-computerd-linux-x64',
        tag: '0.8.0',
        configuredTag: '0.8.0',
        pinnedDigest: layerDigest,
      },
      {
        kind: 'node-tarball',
        name: 'Node.js linux-x64 tarball',
        repository: 'nodejs.org/dist',
        tag: '26.3.0',
        configuredTag: '26.3.0',
        pinnedDigest: `sha256:${nodeSum}`,
      },
    ]);
  });

  it('reads the pins of this checkout', () => {
    const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    expect(
      parseRuntimeArtifactPins({
        packageJson: read('package.json'),
        baseSource: read('user-workspace-runtime/src/base-container.ts'),
      }).map((pin) => [pin.name, pin.tag === pin.configuredTag]),
    ).toEqual([
      ['Cloudflare computerd layer', true],
      ['Node.js linux-x64 tarball', true],
    ]);
  });

  it('reports current pins when what is published still matches them', async () => {
    const fetchImpl = publishedFetch();
    const result = await checkRuntimeArtifacts(pins(), fetchImpl);

    expect(result.status).toBe('current');
    expect(result.results).toHaveLength(2);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('reports drift without hiding what is published instead', async () => {
    const published = `sha256:${'d'.repeat(64)}`;
    const result = await checkRuntimeArtifacts(
      pins(),
      publishedFetch({ layers: [published], nodeSum: 'e'.repeat(64) }),
    );

    expect(result.status).toBe('drift');
    expect(result.results[0]).toMatchObject({ remoteDigest: published, status: 'drift' });
    expect(result.results[1]).toMatchObject({ remoteDigest: `sha256:${'e'.repeat(64)}`, status: 'drift' });
    expect(result.markdown).toContain('Runtime artifact pins need attention');
  });

  it('asks for a review when computerd is no longer a single layer', async () => {
    const result = await checkRuntimeArtifacts(pins(), publishedFetch({ layers: [layerDigest, layerDigest] }));

    expect(result.status).toBe('drift');
    expect(result.results[0]?.detail).toContain('has 2 layers');
  });

  it('reports a computerd pin whose version no longer matches its package', async () => {
    const result = await checkRuntimeArtifacts(pins('0.6.0'), publishedFetch());

    expect(result.status).toBe('drift');
    expect(result.results[0]?.detail).toContain('does not match the package 0.8.0');
  });

  it('renders operational failures for the same tracking issue', () => {
    const result = errorReport(new Error('registry unavailable'));

    expect(result.status).toBe('error');
    expect(result.markdown).toContain('registry unavailable');
  });
});
