import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCommittedWranglerConfig, PLACEHOLDER_D1_ID } from './lib/cloudflare-config.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(rootDir, 'cloudflare.config.ts');
/** `cf d1 list` pages; a page shorter than this is the last. */
const D1_LIST_PAGE_SIZE = 100;
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

function runCf(args) {
  if (isDryRun) {
    console.log(`[dry-run] pnpm exec cf ${args.join(' ')}`);
    return { stdout: '', stderr: '', status: 0 };
  }

  const result = spawnSync('pnpm', ['exec', 'cf', ...args], {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env, CF_SEND_TELEMETRY: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    fail(
      compactLines([
        `pnpm exec cf ${args.join(' ')} failed with exit code ${result.status}.`,
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

/** Every D1 database in the account, read page by page with `cf d1 list` (a read, even in check mode). */
function listD1Databases() {
  if (isDryRun) {
    return [];
  }
  const databases = [];
  for (let page = 1; ; page++) {
    const result = runCf(['d1', 'list', '--page', String(page), '--per-page', String(D1_LIST_PAGE_SIZE)]);
    const listed = parseJsonOutput(result.stdout, 'cf d1 list');
    if (!Array.isArray(listed)) {
      fail('cf d1 list returned an unexpected shape.');
    }
    databases.push(...listed);
    if (listed.length < D1_LIST_PAGE_SIZE) {
      return databases;
    }
  }
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
    runCf(['d1', 'create', '--name', databaseName]);
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
function setBindingId(raw, bindingName, currentId, nextId, placeholderId) {
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

async function main() {
  validateArguments();
  const { raw, config } = await readConfig();
  const applicationD1 = getBinding(config, 'd1_databases', 'DB');
  const applicationDatabaseId = ensureD1Database(applicationD1);
  if (!isCheck) {
    updateD1DatabaseId(raw, applicationD1, applicationDatabaseId);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
