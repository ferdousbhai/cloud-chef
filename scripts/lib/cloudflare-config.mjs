import { convertToWranglerConfig, loadAndParseConfig } from '@cloudflare/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Values cloudflare.config.ts binds only when the deploy tooling supplies them. */
const DEPLOY_INJECTED_VARS = Object.freeze(['COMMIT_SHA', 'CLOUDFLARE_OAUTH_CLIENT_ID']);

/** Where `writeDerivedWranglerConfig` puts the Wrangler-format view of cloudflare.config.ts. */
const DERIVED_WRANGLER_CONFIG_PATH = resolve(rootDir, '.cloudflare/wrangler.json');

/**
 * Evaluate cloudflare.config.ts as a production build does, with the deploy-injected values absent so callers see
 * exactly what is committed, and convert it with the same converter `cf deploy` uses. Verifiers can therefore keep
 * checking the Wrangler-format fields (`d1_databases`, `routes`, `vars`, ...) that are actually uploaded.
 * @param {{ path?: string }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function loadCommittedWranglerConfig({ path = resolve(rootDir, 'cloudflare.config.ts') } = {}) {
  const saved = Object.fromEntries(DEPLOY_INJECTED_VARS.map((name) => [name, process.env[name]]));
  for (const name of DEPLOY_INJECTED_VARS) {
    delete process.env[name];
  }
  let parsed;
  try {
    ({ result: parsed } = await loadAndParseConfig(path, { mode: 'production', isPreview: false }));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
  }
  if (!parsed?.success) {
    throw new Error(`${relative(rootDir, path)} is invalid: ${JSON.stringify(parsed?.error?.issues ?? parsed?.error)}`);
  }
  return convertToWranglerConfig({ containers: [], ...parsed.data });
}

/**
 * Write the committed config in Wrangler format for the tools that still read only Wrangler config files:
 * @cloudflare/vitest-pool-workers and `wrangler d1 migrations apply --local` (`cf d1 migrations apply --local`
 * applies the migrations but never exits). Paths are rebased onto the file's directory, the control-plane
 * migrations directory is restored because cf passes it on the command line instead, and Workflow `exports` are
 * dropped because the pool's Wrangler predates them (the `workflows` binding list still declares each one). A
 * Workflow's `script_name` naming this same Worker is dropped too: the pool would look for it as another Worker.
 * @param {{ path?: string }} [options]
 */
export async function writeDerivedWranglerConfig({ path = DERIVED_WRANGLER_CONFIG_PATH } = {}) {
  const config = await loadCommittedWranglerConfig();
  const fromConfigDirectory = (target) => relative(dirname(path), resolve(rootDir, target));
  const { exports: configExports, ...rest } = config;
  const otherExports = Object.entries(configExports ?? {}).filter(([, value]) => value?.type !== 'workflow');
  const derived = {
    ...rest,
    main: fromConfigDirectory(config.main),
    workflows: config.workflows?.map(({ script_name: scriptName, ...workflow }) =>
      scriptName === undefined || scriptName === config.name ? workflow : { ...workflow, script_name: scriptName },
    ),
    d1_databases: config.d1_databases?.map((database) =>
      database.binding === 'DB' ? { ...database, migrations_dir: fromConfigDirectory('migrations') } : database,
    ),
  };
  if (otherExports.length > 0) {
    derived.exports = Object.fromEntries(otherExports);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(derived, null, 2)}\n`);
  return path;
}
