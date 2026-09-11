import { blake3 } from '@noble/hashes/blake3.js';
import { extname } from 'node:path';
import { bytesToBase64, bytesToHex } from '~/lib/hex-digest';

export const MAX_DEPLOYMENT_ARTIFACT_FILES = 20_000;
// Stay below Cloudflare's 25 MiB per-asset product limit so multipart overhead
// and future provider-side validation cannot turn our advertised cap into an
// edge-case rejection.
const MAX_DEPLOYMENT_ARTIFACT_FILE_BYTES = 24 * 1024 * 1024;
export const MAX_DEPLOYMENT_ARTIFACT_BYTES = 64 * 1024 * 1024;
// A raw cap at the Free-plan compressed limit is deliberately conservative:
// no input can expand past the universal 3 MiB compressed Worker allowance.
const MAX_DEPLOYMENT_WORKER_MODULE_BYTES = 3 * 1024 * 1024 - 64 * 1024;

export type DeploymentArtifactFile = {
  path: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
};

export type PreparedDeploymentArtifact = {
  revision: string;
  mainModule: string;
  modules: DeploymentArtifactFile[];
  assets: DeploymentArtifactFile[];
  migrations: {
    DB: Array<{ name: string; sql: string }>;
    AGENT_SECURITY_DB: Array<{ name: string; sql: string }>;
  };
};

/** Validate every byte returned by the untrusted project build boundary. */
export async function validatePreparedDeploymentArtifact(
  value: PreparedDeploymentArtifact,
  expected: { revision: string; projectType: 'web_app' | 'worker' },
): Promise<PreparedDeploymentArtifact> {
  if (!value || typeof value !== 'object' || value.revision !== expected.revision) {
    throw new Error('The prepared deployment artifact does not match the approved revision.');
  }
  const expectedMain = expected.projectType === 'worker' ? 'server.js' : 'index.js';
  if (value.mainModule !== expectedMain || !Array.isArray(value.modules) || !Array.isArray(value.assets)) {
    throw new Error('The prepared deployment artifact is invalid.');
  }
  if (expected.projectType === 'worker' && value.assets.length !== 0) {
    throw new Error('A Worker-only deployment artifact cannot contain static assets.');
  }
  const files = [...value.modules, ...value.assets];
  if (
    value.modules.length === 0 ||
    files.length > MAX_DEPLOYMENT_ARTIFACT_FILES ||
    value.modules.filter((file) => file.path === value.mainModule).length !== 1
  ) {
    throw new Error('The prepared deployment artifact has an invalid file inventory.');
  }
  let totalBytes = 0;
  let workerModuleBytes = 0;
  const modulePaths = new Set<string>();
  const assetPaths = new Set<string>();
  const canonicalPaths = new Set<string>();
  for (const file of value.modules) {
    await validateFile(file, modulePaths, canonicalPaths, 'module');
    if (!/\.(?:js|mjs|wasm)$/.test(file.path)) {
      throw new Error('The prepared deployment artifact contains an unsupported Worker module.');
    }
    totalBytes += file.size;
    workerModuleBytes += file.size;
  }
  if (workerModuleBytes > MAX_DEPLOYMENT_WORKER_MODULE_BYTES) {
    throw new Error('The prepared Worker modules exceed the universal Worker size limit.');
  }
  for (const file of value.assets) {
    await validateFile(file, assetPaths, canonicalPaths, 'asset');
    totalBytes += file.size;
  }
  if (totalBytes > MAX_DEPLOYMENT_ARTIFACT_BYTES) {
    throw new Error('The prepared deployment artifact exceeds its aggregate size limit.');
  }
  if (!value.migrations || typeof value.migrations !== 'object') {
    throw new Error('The prepared deployment migrations are invalid.');
  }
  for (const migrations of [value.migrations.DB, value.migrations.AGENT_SECURITY_DB]) {
    if (!Array.isArray(migrations) || migrations.length > 1_000) {
      throw new Error('The prepared deployment migrations are invalid.');
    }
    const names = new Set<string>();
    for (const migration of migrations) {
      if (
        !migration ||
        typeof migration !== 'object' ||
        typeof migration.name !== 'string' ||
        !/^\d{4}_[a-zA-Z0-9._-]+\.sql$/.test(migration.name) ||
        names.has(migration.name) ||
        typeof migration.sql !== 'string' ||
        migration.sql.length === 0 ||
        new TextEncoder().encode(migration.sql).byteLength > MAX_DEPLOYMENT_ARTIFACT_FILE_BYTES
      ) {
        throw new Error('The prepared deployment migrations are invalid.');
      }
      names.add(migration.name);
      totalBytes += new TextEncoder().encode(migration.sql).byteLength;
    }
  }
  if (totalBytes > MAX_DEPLOYMENT_ARTIFACT_BYTES) {
    throw new Error('The prepared deployment artifact exceeds its aggregate size limit.');
  }
  return value;
}

export async function deploymentAssetHash(file: Pick<DeploymentArtifactFile, 'path' | 'bytes'>): Promise<string> {
  // Wrangler 4.118.0's Workers Assets protocol hashes the base64 payload plus
  // its extension with BLAKE3 and sends the first 128 bits as lowercase hex.
  const input = new TextEncoder().encode(`${bytesToBase64(file.bytes)}${deploymentAssetExtension(file.path)}`);
  return bytesToHex(blake3(input)).slice(0, 32);
}

/** Durable identity for the exact module, asset, and migration bytes produced by validation. */
export async function preparedDeploymentArtifactDigest(value: PreparedDeploymentArtifact): Promise<string> {
  const inventory = {
    revision: value.revision,
    mainModule: value.mainModule,
    modules: value.modules.map((file) => [file.path, file.size, file.sha256]),
    assets: value.assets.map((file) => [file.path, file.size, file.sha256]),
    migrations: {
      DB: await migrationInventory(value.migrations.DB),
      AGENT_SECURITY_DB: await migrationInventory(value.migrations.AGENT_SECURITY_DB),
    },
  };
  return sha256Bytes(new TextEncoder().encode(JSON.stringify(inventory)));
}

export function deploymentAssetExtension(path: string): string {
  return extname(path).slice(1);
}

async function validateFile(
  file: DeploymentArtifactFile,
  paths: Set<string>,
  canonicalPaths: Set<string>,
  kind: 'module' | 'asset',
): Promise<void> {
  const canonicalPath = typeof file?.path === 'string' ? file.path.toLowerCase() : '';
  if (
    !file ||
    typeof file !== 'object' ||
    typeof file.path !== 'string' ||
    !isSafeRelativePath(file.path) ||
    paths.has(file.path) ||
    canonicalPaths.has(canonicalPath) ||
    !(file.bytes instanceof Uint8Array) ||
    file.bytes.byteLength !== file.size ||
    file.size < 0 ||
    file.size > MAX_DEPLOYMENT_ARTIFACT_FILE_BYTES ||
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    (await sha256Bytes(file.bytes)) !== file.sha256
  ) {
    throw new Error(`The prepared deployment ${kind} is invalid.`);
  }
  paths.add(file.path);
  canonicalPaths.add(canonicalPath);
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    /^[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/.test(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const input = new Uint8Array(value).buffer;
  const digest = await crypto.subtle.digest('SHA-256', input);
  return bytesToHex(new Uint8Array(digest));
}

async function migrationInventory(
  migrations: readonly { name: string; sql: string }[],
): Promise<Array<[string, string]>> {
  return Promise.all(
    migrations.map(async (migration): Promise<[string, string]> => [
      migration.name,
      await sha256Bytes(new TextEncoder().encode(migration.sql)),
    ]),
  );
}
