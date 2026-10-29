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

const REGISTRIES = {
  'docker.io': {
    registry: 'https://registry-1.docker.io',
    tokenUrl: (repository) =>
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
  },
  'ghcr.io': {
    registry: 'https://ghcr.io',
    tokenUrl: (repository) => `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`,
  },
};

/**
 * The bases the workspace image is built from (user-workspace-image/Dockerfile), each pinned by tag and digest.
 * computerd and sandbox-shim must carry the exact versions of the packages that speak their protocols.
 */
export function parseRuntimeArtifactPins({ packageJson, dockerfile }) {
  const manifest = JSON.parse(packageJson);
  const computerVersion = exactDependencyVersion(manifest, '@cloudflare/computer');
  const sandboxVersion = exactDependencyVersion(manifest, '@cloudflare/sandbox');
  const base = (arg, name, expectedTag) => {
    const match = new RegExp(`^ARG ${arg}=([a-z0-9.]+)/([^:@\\s]+):([^@\\s]+)@(sha256:[a-f0-9]{64})\\s*$`, 'm').exec(
      dockerfile,
    );
    if (!match || !Object.hasOwn(REGISTRIES, match[1])) {
      throw new Error(`Could not find the pinned ${name}.`);
    }
    return {
      name,
      host: match[1],
      repository: match[2],
      tag: expectedTag ?? match[3],
      configuredTag: match[3],
      pinnedDigest: match[4],
    };
  };
  return [
    base('COMPUTERD_IMAGE', 'Cloudflare computerd image', computerVersion),
    base('SANDBOX_SHIM_IMAGE', 'Cloudflare Sandbox image (sandbox-shim)', sandboxVersion),
    base('NODE_IMAGE', 'Node.js base image'),
  ];
}

export async function checkRuntimeArtifacts(pins, fetchImpl = fetch) {
  const results = [];
  for (const pin of pins) {
    if (pin.configuredTag !== pin.tag) {
      results.push({
        ...pin,
        status: 'drift',
        detail: `image tag ${pin.configuredTag} does not match the package ${pin.tag}`,
      });
      continue;
    }
    const registry = REGISTRIES[pin.host];
    const manifest = await fetchManifest(
      {
        registry: registry.registry,
        tokenUrl: registry.tokenUrl(pin.repository),
        repository: pin.repository,
        reference: pin.tag,
      },
      fetchImpl,
    );
    const remoteDigest = requiredDigestHeader(manifest.response, pin.name);
    results.push({
      ...pin,
      remoteDigest,
      status: remoteDigest === pin.pinnedDigest ? 'current' : 'drift',
      detail:
        remoteDigest === pin.pinnedDigest
          ? 'immutable image digest matches the published tag'
          : 'published tag resolves to a different image digest',
    });
  }
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
    '- Every base: `user-workspace-image/Dockerfile`',
    '',
    'Keep the immutable digest pin, rebuild and publish the image (`pnpm run workspace-image:publish`), then run `pnpm run validate`.',
    '',
  ].join('\n');
}

async function main() {
  let result;
  try {
    const [packageJson, dockerfile] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../user-workspace-image/Dockerfile', import.meta.url), 'utf8'),
    ]);
    result = await checkRuntimeArtifacts(parseRuntimeArtifactPins({ packageJson, dockerfile }));
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
