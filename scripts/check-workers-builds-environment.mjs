import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateWorkersBuildMetadata } from './deploy-production.mjs';
import { readPinnedToolchain } from './lib/toolchain.mjs';

/**
 * The build runs on the toolchain `.nvmrc` and `packageManager` pin.
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   nodeVersion?: string;
 *   spawn?: typeof spawnSync;
 *   toolchain?: { node: string; pnpm: string };
 * }} [options]
 */
export function checkWorkersBuildEnvironment({
  env = process.env,
  nodeVersion = process.version,
  spawn = spawnSync,
  toolchain = readPinnedToolchain(),
} = {}) {
  validateWorkersBuildMetadata({ env, spawn });
  if (nodeVersion !== `v${toolchain.node}`) {
    throw new Error(`Workers Builds must use Node.js v${toolchain.node}; found ${nodeVersion}.`);
  }
  requireCommandOutput(spawn, 'pnpm', ['--version'], toolchain.pnpm, 'pnpm');
}

function requireCommandOutput(spawn, command, args, expected, label) {
  const result = spawn(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  requireCompleted(result, label);
  const actual = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (actual !== expected) {
    throw new Error(`Workers Builds must use ${label} ${expected}; found ${actual || '<empty>'}.`);
  }
}

function requireCompleted(result, label) {
  if (result.error) {
    throw new Error(`${label} is unavailable in Workers Builds: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim())
      .join('\n');
    throw new Error(`${label} check failed with exit status ${result.status}${detail ? `: ${detail}` : '.'}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkWorkersBuildEnvironment();
    console.log('Workers Builds identity and toolchain are ready.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
