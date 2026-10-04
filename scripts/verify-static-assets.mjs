import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVerifierIfMain } from './run-verifier.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `vite build` writes the Worker as Build Output: `cf deploy --prebuilt` uploads `assets/` publicly and `bundle/`
 * (with every `.map` in it, as private Worker source maps) as the Worker. */
const builtWorkerDirectory = resolve(rootDir, '.cloudflare/output/v0/workers/default');
const builtWorkerConfigPath = join(builtWorkerDirectory, 'worker.config.json');
const sourceLicenseArtifactPath = resolve(rootDir, 'public/THIRD_PARTY_LICENSES.txt');

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

const LOCAL_ENVIRONMENT_FILE = /^(?:\.dev\.vars|\.env)(?:\..*)?$/;

export function findStaticAssetExposureErrors({ assetDirectory, bundleDirectory }) {
  const errors = [];
  const bundleFiles = walkFiles(bundleDirectory).map((path) => relative(bundleDirectory, path));
  if (!bundleFiles.includes('index.js.map')) {
    errors.push('The built Worker bundle must include index.js.map so cf deploy uploads it as a private source map.');
  }

  const assetFiles = walkFiles(assetDirectory)
    .map((path) => relative(assetDirectory, path))
    .sort();
  const sourceMaps = assetFiles.filter((path) => path.endsWith('.map'));
  if (sourceMaps.length > 0) {
    errors.push(`Client source maps would be deployed as public assets: ${sourceMaps.join(', ')}.`);
  }
  const environmentFiles = [
    ...assetFiles.map((path) => ['assets', path]),
    ...bundleFiles.map((path) => ['bundle', path]),
  ]
    .filter(([, path]) => LOCAL_ENVIRONMENT_FILE.test(basename(path)))
    .map(([directory, path]) => `${directory}/${path}`);
  if (environmentFiles.length > 0) {
    errors.push(`Local environment files would be deployed: ${environmentFiles.join(', ')}.`);
  }
  return errors;
}

export function findDeployedLicenseArtifactErrors({ sourceContent, deployedContent }) {
  if (typeof sourceContent !== 'string' || sourceContent.length === 0) {
    return ['public/THIRD_PARTY_LICENSES.txt must be a non-empty generated license artifact.'];
  }
  if (deployedContent === null) {
    return ['The built client must include THIRD_PARTY_LICENSES.txt.'];
  }
  return deployedContent === sourceContent
    ? []
    : ['The built client THIRD_PARTY_LICENSES.txt must exactly match the generated public artifact.'];
}

export function verifyStaticAssets() {
  if (!existsSync(builtWorkerConfigPath)) {
    return [
      `${relative(rootDir, builtWorkerConfigPath)} is missing; run pnpm run build before static asset verification.`,
    ];
  }
  const assetDirectory = join(builtWorkerDirectory, 'assets');
  const bundleDirectory = join(builtWorkerDirectory, 'bundle');
  for (const directory of [assetDirectory, bundleDirectory]) {
    if (!existsSync(directory)) {
      return [`The built Worker directory does not exist: ${relative(rootDir, directory)}.`];
    }
  }
  const errors = findStaticAssetExposureErrors({ assetDirectory, bundleDirectory });
  const deployedLicenseArtifactPath = resolve(assetDirectory, 'THIRD_PARTY_LICENSES.txt');
  errors.push(
    ...findDeployedLicenseArtifactErrors({
      sourceContent: existsSync(sourceLicenseArtifactPath) ? readFileSync(sourceLicenseArtifactPath, 'utf8') : '',
      deployedContent: existsSync(deployedLicenseArtifactPath)
        ? readFileSync(deployedLicenseArtifactPath, 'utf8')
        : null,
    }),
  );
  return errors;
}

runVerifierIfMain(import.meta.url, verifyStaticAssets);
