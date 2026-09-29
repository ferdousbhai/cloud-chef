import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  D1_DATABASE_ID_PATTERN,
  KV_NAMESPACE_ID_PATTERN,
  PLACEHOLDER_D1_DATABASE_ID,
  PLACEHOLDER_KV_NAMESPACE_ID,
  parseCloudflareProject,
} from "./lib/cloudflare-project.mjs";
import {
  readCloudflareProject,
  runCf,
  writeCloudflareProject,
} from "./lib/cloudflare-project-files.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KV_NAMESPACE_TITLE = "cloudchef-cloudflare-app-cache";
const isDryRun = process.argv.includes("--dry-run");
const isCheck = process.argv.includes("--check");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function validateArguments() {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => arg !== "--dry-run" && arg !== "--check") ||
    args.length > 1
  ) {
    fail(
      "Usage: node scripts/provision-cloudflare-production.mjs [--check|--dry-run]",
    );
  }
}

/** Run one cf command and parse the JSON it prints; cf unwraps the API envelope. */
function cfJson(args) {
  const result = runCf(rootDir, args);
  if (result.status !== 0) {
    fail(
      [
        `cf ${args.join(" ")} failed with exit code ${result.status}.`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`cf ${args.join(" ")} did not print JSON.`);
  }
}

let d1Databases;

/** One listing serves both databases; the name filter would cost a CLI start-up per database. */
function listD1Databases() {
  d1Databases ??= cfJson(["d1", "list", "--per-page", "1000"]);
  return d1Databases;
}

function d1DatabaseWithName(databases, name) {
  return Array.isArray(databases)
    ? databases.find((database) => database?.name === name)
    : undefined;
}

function r2BucketNames(output) {
  const buckets = Array.isArray(output) ? output : output?.buckets;
  return Array.isArray(buckets)
    ? buckets.map((bucket) => bucket?.name).filter(Boolean)
    : [];
}

function ensureD1Database(database, label) {
  const configured = database.id !== PLACEHOLDER_D1_DATABASE_ID;
  if (isCheck && !configured) {
    fail(`${label} must have a provisioned D1 database id before release.`);
  }
  if (isDryRun) {
    console.log(`[dry-run] Would ensure D1 database ${database.name} exists.`);
    return database.id;
  }
  const existing = d1DatabaseWithName(listD1Databases(), database.name);
  if (configured) {
    if (existing?.uuid !== database.id) {
      fail(
        `${label} D1 database ${database.id} is not the account's ${database.name} database.`,
      );
    }
    console.log(
      `D1 database ${database.name} is configured as ${database.id}.`,
    );
    return database.id;
  }
  if (existing?.uuid) {
    return existing.uuid;
  }
  const created = cfJson(["d1", "create", "--name", database.name]);
  if (!D1_DATABASE_ID_PATTERN.test(created?.uuid ?? "")) {
    fail(`Unable to determine the D1 database id for ${database.name}.`);
  }
  return created.uuid;
}

function ensureKvNamespace(kv) {
  const configured = kv.id !== PLACEHOLDER_KV_NAMESPACE_ID;
  if (isCheck && !configured) {
    fail("APP_CACHE must have a provisioned KV namespace id before release.");
  }
  if (isDryRun) {
    console.log(
      `[dry-run] Would ensure KV namespace ${KV_NAMESPACE_TITLE} exists.`,
    );
    return kv.id;
  }
  const namespaces = cfJson(["kv", "namespaces", "list", "--per-page", "1000"]);
  const list = Array.isArray(namespaces) ? namespaces : [];
  if (configured) {
    if (!list.some((namespace) => namespace?.id === kv.id)) {
      fail(`KV namespace ${kv.id} was not found in the Cloudflare account.`);
    }
    return kv.id;
  }
  const existing = list.find(
    (namespace) => namespace?.title === KV_NAMESPACE_TITLE,
  );
  if (KV_NAMESPACE_ID_PATTERN.test(existing?.id ?? "")) {
    return existing.id;
  }
  const created = cfJson([
    "kv",
    "namespaces",
    "create",
    "--title",
    KV_NAMESPACE_TITLE,
  ]);
  if (!KV_NAMESPACE_ID_PATTERN.test(created?.id ?? "")) {
    fail(`Unable to determine the KV namespace id for ${KV_NAMESPACE_TITLE}.`);
  }
  return created.id;
}

function ensureR2Bucket(r2) {
  if (isDryRun) {
    console.log(`[dry-run] Would ensure R2 bucket ${r2.name} exists.`);
    return;
  }
  if (r2BucketNames(cfJson(["r2", "buckets", "list"])).includes(r2.name)) {
    console.log(`R2 bucket ${r2.name} already exists.`);
    return;
  }
  if (isCheck) {
    fail(`R2 bucket ${r2.name} must already exist before release.`);
  }
  cfJson(["r2", "buckets", "create", "--name", r2.name]);
  console.log(`R2 bucket ${r2.name} is available.`);
}

function main() {
  validateArguments();
  const { project, errors } = readCloudflareProject(rootDir);
  if (errors.length > 0) {
    fail(errors.join("\n"));
  }
  const next = structuredClone(project);
  if (next.d1) {
    next.d1.id = ensureD1Database(next.d1, "DB");
  }
  if (next.agent) {
    next.agent.securityD1.id = ensureD1Database(
      next.agent.securityD1,
      "AGENT_SECURITY_DB",
    );
  }
  if (next.r2) {
    ensureR2Bucket(next.r2);
  }
  if (next.kv) {
    next.kv.id = ensureKvNamespace(next.kv);
  }
  const resolved = parseCloudflareProject(next);
  if (resolved.errors.length > 0) {
    fail(resolved.errors.join("\n"));
  }
  if (
    !isCheck &&
    !isDryRun &&
    JSON.stringify(next) !== JSON.stringify(project)
  ) {
    writeCloudflareProject(rootDir, next);
    console.log("Updated cloudflare.project.json and cloudflare.config.ts.");
  }
}

main();
