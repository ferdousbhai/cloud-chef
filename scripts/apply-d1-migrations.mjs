import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { controlPlaneDatabaseId, loadCommittedWranglerConfig } from './lib/cloudflare-config.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {Record<string, any>} config Wrangler-format view of cloudflare.config.ts. */
export function remoteD1MigrationArgs(config) {
  return ['exec', 'cf', 'd1', 'migrations', 'apply', controlPlaneDatabaseId(config), '--dir', 'migrations'];
}

/**
 * The local database, in `.cloudflare/state` beside cloudflare.config.ts, which is where `vite dev` and
 * `vite preview` keep theirs (the Vite plugin's default `persistState`) and where `cf --local` writes.
 * @param {Record<string, any>} config Wrangler-format view of cloudflare.config.ts.
 */
export function localD1MigrationArgs(config) {
  return [
    'exec',
    'cf',
    'd1',
    'migrations',
    'apply',
    controlPlaneDatabaseId(config, { local: true }),
    '--dir',
    'migrations',
    '--local',
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--local', '--remote'].includes(args[0])) {
    console.error('Usage: node scripts/apply-d1-migrations.mjs --local|--remote');
    process.exit(1);
  }
  const config = await loadCommittedWranglerConfig();
  const pnpmArgs = args[0] === '--local' ? localD1MigrationArgs(config) : remoteD1MigrationArgs(config);
  const result = spawnSync('pnpm', pnpmArgs, { cwd: rootDir, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
