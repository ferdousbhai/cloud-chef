import { convertToWranglerConfig, loadAndParseConfig } from '@cloudflare/config';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Values cloudflare.config.ts binds only when the deploy tooling supplies them. */
const DEPLOY_INJECTED_VARS = Object.freeze(['COMMIT_SHA', 'CLOUDFLARE_OAUTH_CLIENT_ID']);

/** The D1 database id cloudflare.config.ts carries until `pnpm run provision:production` binds a real one. */
export const PLACEHOLDER_D1_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Evaluate cloudflare.config.ts as a production build does, with the deploy-injected values absent so callers see
 * exactly what is committed, and convert it with Cloudflare's converter (`@cloudflare/config`, the release the
 * builder pins too). Verifiers can therefore keep checking the Wrangler-format fields (`d1_databases`, `routes`,
 * `vars`, ...) of what is uploaded.
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
 * The control-plane D1 database's id. `cf d1` addresses a database by id, so it is read from cloudflare.config.ts
 * rather than repeated. The local database is named by the same id, placeholder or not (`local`).
 * @param {Record<string, any>} config Wrangler-format view of cloudflare.config.ts.
 * @param {{ local?: boolean }} [options]
 * @returns {string}
 */
export function controlPlaneDatabaseId(config, { local = false } = {}) {
  const database = config?.d1_databases?.find((binding) => binding?.binding === 'DB');
  if (!database?.database_id || (!local && database.database_id === PLACEHOLDER_D1_ID)) {
    throw new Error('cloudflare.config.ts must bind DB to a provisioned D1 database id.');
  }
  return database.database_id;
}
