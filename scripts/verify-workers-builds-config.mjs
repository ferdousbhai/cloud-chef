import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCommittedWranglerConfig } from './lib/cloudflare-config.mjs';
import { findWorkersBuildsConfigErrors } from './workers-builds-config.mjs';
import { runVerifierIfMain } from './run-verifier.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(resolve(rootDir, path), 'utf8'));
  } catch (error) {
    errors.push(`${path} must be valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
    return undefined;
  }
}

export async function verifyWorkersBuildsConfig() {
  const errors = [];
  const config = readJson('workers-builds.production.json', errors);
  const packageJson = readJson('package.json', errors);
  const workerConfig = await loadCommittedWranglerConfig();
  const nvmrc = readFileSync(resolve(rootDir, '.nvmrc'), 'utf8');
  const workflowsDirectory = resolve(rootDir, '.github/workflows');
  const githubWorkflowPaths = existsSync(workflowsDirectory)
    ? readdirSync(workflowsDirectory)
        .filter((entry) => /\.ya?ml$/i.test(entry))
        .sort()
        .map((entry) => `.github/workflows/${entry}`)
    : [];
  const browserGateWorkflowPath = resolve(rootDir, '.github/workflows/browser-gate.yml');
  errors.push(
    ...findWorkersBuildsConfigErrors({
      config,
      packageJson,
      nvmrc,
      githubWorkflowPaths,
      browserGateWorkflow: existsSync(browserGateWorkflowPath)
        ? readFileSync(browserGateWorkflowPath, 'utf8')
        : undefined,
      githubCompositeActionExists: existsSync(resolve(rootDir, '.github/actions/setup-and-build/action.yaml')),
      workerConfig,
    }),
  );
  return errors;
}

runVerifierIfMain(import.meta.url, verifyWorkersBuildsConfig);
