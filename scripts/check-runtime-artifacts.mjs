/**
 * Whether what the workspace containers' base setup downloads (user-workspace-runtime/src/base-container.ts) is still
 * what its publishers serve under the pinned versions: computerd's single GHCR layer, by digest, and Node's linux-x64
 * tarball, by the SHA-256 nodejs.org lists for it. Run daily by .github/workflows/runtime-artifacts.yml; read-only.
 */
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

/** A `const NAME = '<value>';` of the base setup's source, which must be there. */
function sourceConstant(source, name) {
  const match = new RegExp(`^(?:export )?const ${name} = '([^']+)';$`, 'm').exec(source);
  if (!match) {
    throw new Error(`Could not find ${name} in user-workspace-runtime/src/base-container.ts.`);
  }
  return match[1];
}

/** The base setup's downloaded pins, with the versions this checkout says they must have. */
export function parseRuntimeArtifactPins({ packageJson, baseSource }) {
  const manifest = JSON.parse(packageJson);
  const computerVersion = exactDependencyVersion(manifest, '@cloudflare/computer');
  const nodeVersion = sourceConstant(baseSource, 'BASE_NODE_VERSION');
  return [
    {
      kind: 'ghcr-layer',
      name: 'Cloudflare computerd layer',
      repository: sourceConstant(baseSource, 'BASE_COMPUTERD_REPOSITORY'),
      tag: computerVersion,
      configuredTag: sourceConstant(baseSource, 'BASE_COMPUTERD_VERSION'),
      pinnedDigest: sourceConstant(baseSource, 'BASE_COMPUTERD_LAYER_DIGEST'),
    },
    {
      kind: 'node-tarball',
      name: 'Node.js linux-x64 tarball',
      repository: 'nodejs.org/dist',
      tag: nodeVersion,
      configuredTag: nodeVersion,
      pinnedDigest: `sha256:${sourceConstant(baseSource, 'BASE_NODE_SHA256')}`,
    },
  ];
}

export async function checkRuntimeArtifacts(pins, fetchImpl = fetch) {
  const results = [];
  for (const pin of pins) {
    if (pin.configuredTag !== pin.tag) {
      results.push({
        ...pin,
        status: 'drift',
        detail: `pinned version ${pin.configuredTag} does not match the package ${pin.tag}`,
      });
      continue;
    }
    const remoteDigest =
      pin.kind === 'ghcr-layer'
        ? await publishedComputerdLayer(pin, fetchImpl)
        : await publishedNodeTarball(pin, fetchImpl);
    const current = remoteDigest.digest === pin.pinnedDigest;
    results.push({
      ...pin,
      remoteDigest: remoteDigest.digest,
      status: current ? 'current' : 'drift',
      detail: remoteDigest.problem ?? (current ? 'matches what is published' : 'published under a different digest'),
    });
  }
  return report(results);
}

async function publishedComputerdLayer(pin, fetchImpl) {
  const tokenResponse = await fetchImpl(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${pin.repository}:pull`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) },
  );
  if (!tokenResponse.ok) {
    throw new Error(`Registry token request failed with HTTP ${tokenResponse.status}.`);
  }
  const token = (await tokenResponse.json()).token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Registry token response did not include a token.');
  }
  const response = await fetchImpl(`https://ghcr.io/v2/${pin.repository}/manifests/${pin.tag}`, {
    headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${pin.repository}:${pin.tag} manifest request failed with HTTP ${response.status}.`);
  }
  const layers = (await response.json()).layers;
  if (!Array.isArray(layers) || layers.length !== 1) {
    return {
      digest: undefined,
      problem: `published image has ${Array.isArray(layers) ? layers.length : 'no'} layers; review its layout before changing the setup`,
    };
  }
  const digest = layers[0]?.digest;
  return SHA256_DIGEST.test(digest ?? '')
    ? { digest }
    : { digest: undefined, problem: 'published image has an invalid layer digest' };
}

async function publishedNodeTarball(pin, fetchImpl) {
  const response = await fetchImpl(`https://nodejs.org/dist/v${pin.tag}/SHASUMS256.txt`, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Node.js ${pin.tag} SHASUMS256.txt request failed with HTTP ${response.status}.`);
  }
  const line = (await response.text())
    .split('\n')
    .find((entry) => entry.endsWith(`  node-v${pin.tag}-linux-x64.tar.xz`));
  const sum = line?.split('  ')[0];
  return /^[a-f0-9]{64}$/.test(sum ?? '')
    ? { digest: `sha256:${sum}` }
    : { digest: undefined, problem: 'SHASUMS256.txt lists no linux-x64 tarball' };
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

function exactDependencyVersion(manifest, name) {
  const version = manifest.dependencies?.[name];
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    throw new Error(`${name} must use an exact version for runtime artifact monitoring.`);
  }
  return version;
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
    '| Artifact | Version | Pinned | Published | Result |',
    '| --- | --- | --- | --- | --- |',
    rows,
    '',
    '- Every pin: `user-workspace-runtime/src/base-container.ts`',
    '',
    'Update the pin there, run `pnpm run generate:artifacts`, then `pnpm run validate`. A changed pin makes each runtime set up a new base snapshot once.',
    '',
  ].join('\n');
}

async function main() {
  let result;
  try {
    const [packageJson, baseSource] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../user-workspace-runtime/src/base-container.ts', import.meta.url), 'utf8'),
    ]);
    result = await checkRuntimeArtifacts(parseRuntimeArtifactPins({ packageJson, baseSource }));
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
