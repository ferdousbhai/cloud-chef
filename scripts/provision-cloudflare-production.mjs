import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCommittedWranglerConfig } from './lib/cloudflare-config.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(rootDir, 'cloudflare.config.ts');
const PLACEHOLDER_D1_ID = '00000000-0000-0000-0000-000000000000';
const PLACEHOLDER_KV_ID = '00000000000000000000000000000000';
const isDryRun = process.argv.includes('--dry-run');
const isCheck = process.argv.includes('--check');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function compactLines(lines) {
  return lines.filter((line) => line).join('\n');
}

/** Read cloudflare.config.ts in the Wrangler format `cf deploy` uploads, plus its source for in-place id updates. */
async function readConfig() {
  try {
    return { raw: readFileSync(configPath, 'utf8'), config: await loadCommittedWranglerConfig({ path: configPath }) };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function validateArguments() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run' && arg !== '--check') || (isDryRun && isCheck) || args.length > 1) {
    fail('Usage: node scripts/provision-cloudflare-production.mjs [--check|--dry-run]');
  }
}

function getBinding(config, collectionName, bindingName) {
  const collection = config?.[collectionName];
  if (!Array.isArray(collection)) {
    fail(`cloudflare.config.ts ${collectionName} must be an array.`);
  }

  const index = collection.findIndex((binding) => binding?.binding === bindingName);
  if (index === -1) {
    fail(`cloudflare.config.ts must contain ${collectionName} binding ${bindingName}.`);
  }

  return { binding: collection[index], index };
}

function runWrangler(args, options = {}) {
  if (isDryRun) {
    console.log(`[dry-run] pnpm wrangler ${args.join(' ')}`);
    return { stdout: '', stderr: '', status: 0 };
  }

  const result = spawnSync('pnpm', ['wrangler', ...args], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0 && !options.allowFailure) {
    fail(
      compactLines([
        `pnpm wrangler ${args.join(' ')} failed with exit code ${result.status}.`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]),
    );
  }

  return result;
}

export function parseJsonOutput(stdout, command) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    fail(`${command} returned empty output.`);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const parsed = parseEmbeddedJson(trimmed);
    if (parsed !== undefined) {
      return parsed;
    }
    fail(`${command} did not return parseable JSON.`);
  }
}

function parseEmbeddedJson(output) {
  for (let start = 0; start < output.length; start++) {
    const first = output[start];
    if (first !== '[' && first !== '{') {
      continue;
    }
    if (!startsAtJsonLine(output, start)) {
      continue;
    }

    const last = first === '[' ? ']' : '}';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < output.length; index++) {
      const char = output[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === first) {
        depth++;
      } else if (char === last) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(output.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  return undefined;
}

function startsAtJsonLine(output, start) {
  for (let index = start - 1; index >= 0; index--) {
    const char = output[index];
    if (char === '\n' || char === '\r') {
      return true;
    }
    if (char !== ' ' && char !== '\t') {
      return false;
    }
  }

  return true;
}

export function d1DatabaseId(database) {
  return database?.uuid ?? database?.database_id ?? database?.id;
}

export function d1DatabaseName(database) {
  return database?.name ?? database?.database_name;
}

export function requireMatchingD1Database(databases, configuredId, databaseName) {
  const configuredDatabase = databases.find((database) => d1DatabaseId(database) === configuredId);
  if (!configuredDatabase) {
    throw new Error(`Configured D1 database_id ${configuredId} was not found in the Cloudflare account.`);
  }
  if (d1DatabaseName(configuredDatabase) !== databaseName) {
    throw new Error(
      `Configured D1 database_id ${configuredId} resolves to ` +
        `${JSON.stringify(d1DatabaseName(configuredDatabase))}, not ${JSON.stringify(databaseName)}.`,
    );
  }
  return configuredDatabase;
}

function listD1Databases() {
  if (isDryRun) {
    return [];
  }
  const result = runWrangler(['d1', 'list', '--json']);
  const databases = parseJsonOutput(result.stdout, 'wrangler d1 list --json');
  if (!Array.isArray(databases)) {
    fail('wrangler d1 list --json returned an unexpected shape.');
  }
  return databases;
}

function ensureD1Database(d1) {
  const databaseName = d1.binding?.database_name;
  if (!databaseName) {
    fail('cloudflare.config.ts D1 database_name must be configured.');
  }

  const configuredId = d1.binding?.database_id;
  const hasConfiguredId = configuredId && configuredId !== PLACEHOLDER_D1_ID;
  if (isCheck && !hasConfiguredId) {
    fail(
      `cloudflare.config.ts D1 database ${databaseName} must have a non-placeholder database_id before production release.`,
    );
  }
  if (hasConfiguredId && isDryRun) {
    console.log(`[dry-run] Would verify D1 database ${databaseName} is configured as ${configuredId}.`);
    return configuredId;
  }
  const databases = listD1Databases();
  let configuredDatabase;
  try {
    configuredDatabase = hasConfiguredId ? requireMatchingD1Database(databases, configuredId, databaseName) : undefined;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (configuredDatabase) {
    console.log(`D1 database ${databaseName} is already configured as ${configuredId}.`);
    return configuredId;
  }
  if (isCheck) {
    fail(`D1 database ${databaseName} must already exist before production release.`);
  }

  let database = databases.find((candidate) => d1DatabaseName(candidate) === databaseName);
  if (!database) {
    runWrangler(['d1', 'create', databaseName]);
    database = listD1Databases().find((candidate) => d1DatabaseName(candidate) === databaseName);
  }

  const databaseId = d1DatabaseId(database);
  if (!databaseId) {
    if (isDryRun) {
      console.log(`[dry-run] Would create or reuse D1 database ${databaseName} and update cloudflare.config.ts.`);
      return PLACEHOLDER_D1_ID;
    }
    fail(`Unable to determine D1 database_id for ${databaseName}.`);
  }

  return databaseId;
}

/**
 * Replace a binding's resource id in cloudflare.config.ts source: the first quoted `currentId` after the binding's
 * `NAME:` key, so comments and formatting survive. Placeholder or empty ids never overwrite anything.
 */
export function setBindingId(raw, bindingName, currentId, nextId, placeholderId) {
  if (!nextId || nextId === placeholderId || nextId === currentId) {
    return raw;
  }
  const bindingStart = raw.search(new RegExp(`\\b${bindingName}\\s*:`));
  if (bindingStart === -1 || !currentId) {
    fail(`cloudflare.config.ts must declare ${bindingName} with an id to update.`);
  }
  const idStart = ['"', "'"]
    .map((quote) => raw.indexOf(`${quote}${currentId}${quote}`, bindingStart))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0];
  if (idStart === undefined) {
    fail(`cloudflare.config.ts ${bindingName} id ${currentId} was not found after its binding.`);
  }
  return `${raw.slice(0, idStart + 1)}${nextId}${raw.slice(idStart + 1 + currentId.length)}`;
}

export function setD1DatabaseId(raw, bindingName, currentId, databaseId) {
  return setBindingId(raw, bindingName, currentId, databaseId, PLACEHOLDER_D1_ID);
}

function updateD1DatabaseId(raw, d1, databaseId) {
  const bindingName = d1.binding.binding;
  const nextRaw = setD1DatabaseId(raw, bindingName, d1.binding.database_id, databaseId);
  if (nextRaw !== raw) {
    writeFileSync(configPath, nextRaw);
    console.log(`Updated cloudflare.config.ts ${bindingName} D1 database id to ${databaseId}.`);
  }
  return nextRaw;
}

function updateKvNamespaceId(raw, kv, namespaceId) {
  const nextRaw = setBindingId(raw, 'APP_CACHE', kv.binding.id, namespaceId, PLACEHOLDER_KV_ID);
  if (nextRaw !== raw) {
    writeFileSync(configPath, nextRaw);
    console.log(`Updated cloudflare.config.ts APP_CACHE KV namespace id to ${namespaceId}.`);
  }
  return nextRaw;
}

function ensureKvNamespace(kv) {
  const title = kv.binding?.title ?? 'cloudchef-cloudflare-app-cache';
  const configuredId = kv.binding?.id;
  const hasConfiguredId = configuredId && configuredId !== PLACEHOLDER_KV_ID;
  if (isCheck && !hasConfiguredId) {
    fail('cloudflare.config.ts APP_CACHE must have a non-placeholder namespace id before production release.');
  }
  if (isDryRun) {
    console.log(`[dry-run] Would ensure KV namespace ${title} exists.`);
    return configuredId ?? PLACEHOLDER_KV_ID;
  }
  const list = parseJsonOutput(runWrangler(['kv', 'namespace', 'list']).stdout, 'wrangler kv namespace list');
  if (!Array.isArray(list)) {
    fail('wrangler kv namespace list returned an unexpected shape.');
  }
  const byId = hasConfiguredId ? list.find((item) => item?.id === configuredId) : undefined;
  if (byId) {
    return configuredId;
  }
  if (hasConfiguredId || isCheck) {
    fail(`KV namespace ${title} must already exist before production release.`);
  }
  const existing = list.find((item) => item?.title === title);
  if (typeof existing?.id === 'string') {
    return existing.id;
  }
  runWrangler(['kv', 'namespace', 'create', title]);
  const refreshed = parseJsonOutput(runWrangler(['kv', 'namespace', 'list']).stdout, 'wrangler kv namespace list');
  const created = Array.isArray(refreshed) ? refreshed.find((item) => item?.title === title) : undefined;
  if (typeof created?.id !== 'string') {
    fail(`Unable to determine KV namespace id for ${title}.`);
  }
  return created.id;
}

export function r2BucketExists(output, bucketName) {
  const expectedBucketName = bucketName.trim();
  if (!expectedBucketName) {
    return false;
  }

  return output.split('\n').some((line) => {
    const trimmedLine = line.trim();
    if (trimmedLine === expectedBucketName) {
      return true;
    }

    const cells = trimmedLine.includes('│') ? trimmedLine.split('│') : trimmedLine.split(/\s+/);
    return cells.some((cell) => cell.trim() === expectedBucketName);
  });
}

function ensureR2Bucket(r2) {
  const bucketName = r2.binding?.bucket_name;
  if (!bucketName) {
    fail('cloudflare.config.ts R2 bucket_name must be configured.');
  }

  if (isDryRun) {
    console.log(`[dry-run] Would ensure R2 bucket ${bucketName} exists.`);
    return;
  }

  const listResult = runWrangler(['r2', 'bucket', 'list']);
  if (r2BucketExists(listResult.stdout, bucketName)) {
    console.log(`R2 bucket ${bucketName} already exists.`);
    return;
  }
  if (isCheck) {
    fail(`R2 bucket ${bucketName} must already exist before production release.`);
  }

  const createResult = runWrangler(['r2', 'bucket', 'create', bucketName], {
    allowFailure: true,
  });
  const combinedOutput = `${createResult.stdout}\n${createResult.stderr}`;
  if (createResult.status !== 0 && !/already exists|exists already|bucket.*exists/i.test(combinedOutput)) {
    fail(
      compactLines([
        `pnpm wrangler r2 bucket create ${bucketName} failed with exit code ${createResult.status}.`,
        createResult.stdout?.trim(),
        createResult.stderr?.trim(),
      ]),
    );
  }
  console.log(`R2 bucket ${bucketName} is available.`);
}

async function main() {
  validateArguments();
  const { raw, config } = await readConfig();
  const applicationD1 = getBinding(config, 'd1_databases', 'DB');
  // The CloudChef control-plane Worker has no AppAgent, so AGENT_SECURITY_DB is optional.
  const agentSecurityIndex = config.d1_databases.findIndex((binding) => binding?.binding === 'AGENT_SECURITY_DB');
  const agentSecurityD1 =
    agentSecurityIndex === -1
      ? undefined
      : {
          binding: config.d1_databases[agentSecurityIndex],
          index: agentSecurityIndex,
        };
  const r2 = Array.isArray(config.r2_buckets)
    ? config.r2_buckets.find((binding) => binding?.binding === 'APP_STORAGE')
    : undefined;
  const kvIndex = Array.isArray(config.kv_namespaces)
    ? config.kv_namespaces.findIndex((binding) => binding?.binding === 'APP_CACHE')
    : -1;
  const kv = kvIndex === -1 ? undefined : { binding: config.kv_namespaces[kvIndex], index: kvIndex };

  const applicationDatabaseId = ensureD1Database(applicationD1);
  const agentSecurityDatabaseId = agentSecurityD1 ? ensureD1Database(agentSecurityD1) : undefined;
  if (
    agentSecurityDatabaseId &&
    applicationDatabaseId !== PLACEHOLDER_D1_ID &&
    applicationDatabaseId === agentSecurityDatabaseId
  ) {
    fail('DB and AGENT_SECURITY_DB must resolve to separate D1 databases.');
  }
  if (!isCheck) {
    const withApplicationDatabase = updateD1DatabaseId(raw, applicationD1, applicationDatabaseId);
    if (agentSecurityD1 && agentSecurityDatabaseId) {
      updateD1DatabaseId(withApplicationDatabase, agentSecurityD1, agentSecurityDatabaseId);
    }
  }
  if (r2) {
    ensureR2Bucket({ binding: r2 });
  }
  if (kv) {
    updateKvNamespaceId(readFileSync(configPath, 'utf8'), kv, ensureKvNamespace(kv));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
