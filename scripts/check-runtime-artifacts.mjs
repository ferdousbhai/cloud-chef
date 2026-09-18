import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const ISSUE_MARKER = '<!-- cloudchef-runtime-artifact-watch -->';
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REGISTRY_TIMEOUT_MS = 30_000;

export function parseRuntimeArtifactPins({ packageJson, provisionerSource, toolchainSource }) {
  const manifest = JSON.parse(packageJson);
  const sandboxVersion = exactDependencyVersion(manifest, '@cloudflare/sandbox');
  const computerVersion = exactDependencyVersion(manifest, '@cloudflare/computer');
  const sandboxMatch = /docker\.io\/cloudflare\/sandbox:([^@'"\s]+)@(sha256:[a-f0-9]{64})/.exec(provisionerSource);
  const computerdMatch = /COMPUTERD_LAYER_DIGEST\s*=\s*'(sha256:[a-f0-9]{64})'/.exec(toolchainSource);

  if (!sandboxMatch) {
    throw new Error('Could not find the pinned Cloudflare Sandbox image.');
  }
  if (!EXACT_VERSION.test(sandboxMatch[1])) {
    throw new Error('The pinned Cloudflare Sandbox image must use an exact version tag.');
  }
  if (!computerdMatch) {
    throw new Error('Could not find the pinned computerd layer digest.');
  }

  return {
    sandbox: {
      name: 'Cloudflare Sandbox image',
      repository: 'cloudflare/sandbox',
      tag: sandboxVersion,
      configuredTag: sandboxMatch[1],
      pinnedDigest: sandboxMatch[2],
    },
    computerd: {
      name: 'Cloudflare computerd layer',
      repository: 'cloudflare/computer-computerd-linux-x64',
      tag: computerVersion,
      pinnedDigest: computerdMatch[1],
    },
  };
}

export async function checkRuntimeArtifacts(pins, fetchImpl = fetch) {
  const results = [];

  if (pins.sandbox.configuredTag !== pins.sandbox.tag) {
    results.push({
      ...pins.sandbox,
      status: 'drift',
      detail: `image tag ${pins.sandbox.configuredTag} does not match @cloudflare/sandbox ${pins.sandbox.tag}`,
    });
  } else {
    const manifest = await fetchManifest(
      {
        registry: 'https://registry-1.docker.io',
        tokenUrl: `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${pins.sandbox.repository}:pull`,
        repository: pins.sandbox.repository,
        reference: pins.sandbox.tag,
      },
      fetchImpl,
    );
    const remoteDigest = requiredDigestHeader(manifest.response, pins.sandbox.name);
    results.push({
      ...pins.sandbox,
      remoteDigest,
      status: remoteDigest === pins.sandbox.pinnedDigest ? 'current' : 'drift',
      detail:
        remoteDigest === pins.sandbox.pinnedDigest
          ? 'immutable image digest matches the published tag'
          : 'published tag resolves to a different image digest',
    });
  }

  const manifest = await fetchManifest(
    {
      registry: 'https://ghcr.io',
      tokenUrl: `https://ghcr.io/token?service=ghcr.io&scope=repository:${pins.computerd.repository}:pull`,
      repository: pins.computerd.repository,
      reference: pins.computerd.tag,
    },
    fetchImpl,
  );
  const layers = Array.isArray(manifest.body.layers) ? manifest.body.layers : [];
  const candidateDigest = layers.length === 1 ? layers[0]?.digest : undefined;
  const remoteDigest =
    typeof candidateDigest === 'string' && SHA256_DIGEST.test(candidateDigest) ? candidateDigest : undefined;
  const computerdCurrent = remoteDigest === pins.computerd.pinnedDigest;
  results.push({
    ...pins.computerd,
    remoteDigest,
    status: computerdCurrent ? 'current' : 'drift',
    detail:
      layers.length !== 1
        ? `published image has ${layers.length} layers; review its layout before changing the bootstrap`
        : remoteDigest
          ? computerdCurrent
            ? 'immutable layer digest matches the published tag'
            : 'published tag resolves to a different layer digest'
          : 'published image has an invalid layer digest; review it before changing the bootstrap',
  });

  return report(results);
}

function report(results) {
  const status = results.every((result) => result.status === 'current') ? 'current' : 'drift';
  return {
    status,
    results,
    markdown: renderMarkdown(status, results),
  };
}

export function errorReport(error) {
  const message = safeMarkdownText(error instanceof Error ? error.message : String(error));
  return {
    status: 'error',
    results: [],
    markdown: `${ISSUE_MARKER}\n## Runtime artifact check failed\n\n${message}\n`,
  };
}

async function fetchManifest({ registry, tokenUrl, repository, reference }, fetchImpl) {
  const tokenResponse = await fetchImpl(tokenUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Registry token request failed with HTTP ${tokenResponse.status}.`);
  }
  const token = (await tokenResponse.json()).token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Registry token response did not include a token.');
  }

  const response = await fetchImpl(`${registry}/v2/${repository}/manifests/${reference}`, {
    headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${repository}:${reference} manifest request failed with HTTP ${response.status}.`);
  }
  return { response, body: await response.json() };
}

function exactDependencyVersion(manifest, name) {
  const version = manifest.dependencies?.[name];
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    throw new Error(`${name} must use an exact version for runtime artifact monitoring.`);
  }
  return version;
}

function requiredDigestHeader(response, artifactName) {
  const digest = response.headers.get('docker-content-digest');
  if (!digest || !SHA256_DIGEST.test(digest)) {
    throw new Error(`${artifactName} response did not include a valid Docker-Content-Digest header.`);
  }
  return digest;
}

function safeMarkdownText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replaceAll('`', '\\`')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

function renderMarkdown(status, results) {
  const heading = status === 'current' ? 'Runtime artifact pins are current' : 'Runtime artifact pins need attention';
  const rows = results
    .map(
      (result) =>
        `| ${result.name} | ${result.tag} | \`${result.pinnedDigest}\` | ${result.remoteDigest ? `\`${result.remoteDigest}\`` : 'n/a'} | ${result.detail} |`,
    )
    .join('\n');
  return [
    ISSUE_MARKER,
    `## ${heading}`,
    '',
    '| Artifact | Tag | Pinned | Published | Result |',
    '| --- | --- | --- | --- | --- |',
    rows,
    '',
    '- Sandbox image: `app/workflows/user-workspace-runtime-provisioning.ts`',
    '- computerd layer: `user-workspace-runtime/src/container-toolchain.ts`',
    '',
    'Keep the immutable digest pin, then run `pnpm run validate`.',
    '',
  ].join('\n');
}

async function main() {
  let result;
  try {
    const [packageJson, provisionerSource, toolchainSource] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../app/workflows/user-workspace-runtime-provisioning.ts', import.meta.url), 'utf8'),
      readFile(new URL('../user-workspace-runtime/src/container-toolchain.ts', import.meta.url), 'utf8'),
    ]);
    result = await checkRuntimeArtifacts(parseRuntimeArtifactPins({ packageJson, provisionerSource, toolchainSource }));
  } catch (error) {
    result = errorReport(error);
  }

  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : result.markdown);
  if (result.status !== 'current') {
    process.exitCode = result.status === 'drift' ? 1 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
