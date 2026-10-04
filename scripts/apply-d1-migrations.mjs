import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCommittedWranglerConfig, writeDerivedWranglerConfig } from './lib/cloudflare-config.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER_D1_ID = '00000000-0000-0000-0000-000000000000';
/** `vite dev` and `vite preview` keep local state here (the Vite plugin's default `persistState`). */
const LOCAL_STATE_DIRECTORY = '.cloudflare/state';

/**
 * `cf d1 migrations apply` addresses a database by ID, so read it from cloudflare.config.ts rather than repeating it.
 * @param {Record<string, any>} config Wrangler-format view of cloudflare.config.ts.
 */
export function remoteD1MigrationArgs(config) {
  const database = config?.d1_databases?.find((binding) => binding?.binding === 'DB');
  if (!database?.database_id || database.database_id === PLACEHOLDER_D1_ID) {
    throw new Error('cloudflare.config.ts must bind DB to a provisioned D1 database id.');
  }
  return ['exec', 'cf', 'd1', 'migrations', 'apply', database.database_id, '--dir', 'migrations'];
}

/**
 * `cf d1 migrations apply --local` applies every migration but then never exits, so the local database is migrated
 * with Wrangler against the derived config, into the state directory the Vite plugin serves from.
 * @param {string} configPath
 */
export function localD1MigrationArgs(configPath) {
  return [
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--config',
    relative(rootDir, configPath),
    '--persist-to',
    LOCAL_STATE_DIRECTORY,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--local', '--remote'].includes(args[0])) {
    console.error('Usage: node scripts/apply-d1-migrations.mjs --local|--remote');
    process.exit(1);
  }
  const pnpmArgs =
    args[0] === '--local'
      ? localD1MigrationArgs(await writeDerivedWranglerConfig())
      : remoteD1MigrationArgs(await loadCommittedWranglerConfig());
  const result = spawnSync('pnpm', pnpmArgs, { cwd: rootDir, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
