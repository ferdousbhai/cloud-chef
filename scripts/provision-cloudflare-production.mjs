import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export {
  d1DatabaseId,
  d1DatabaseName,
  parseJsonOutput,
  requireMatchingD1Database,
  r2BucketExists,
  setD1DatabaseId,
} from '../template/scripts/provision-cloudflare-production.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provisionerPath = resolve(rootDir, 'template/scripts/provision-cloudflare-production.mjs');

export function main() {
  const result = spawnSync(process.execPath, [provisionerPath, ...process.argv.slice(2)], {
    cwd: rootDir,
    env: { ...process.env, CLOUDCHEF_PROVISION_ROOT: rootDir },
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
