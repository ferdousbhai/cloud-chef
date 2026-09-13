import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";
import {
  findMissingCommandSteps,
  findWorkerObservabilityErrors,
  findWorkerRuntimeSecretErrors,
  loadsLocalEnvFiles,
  startsLocalDevServer,
  targetsStaging,
} from "./lib/project-policy.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowUnprovisioned = process.argv.includes("--allow-unprovisioned");
const placeholderDatabaseId = "00000000-0000-0000-0000-000000000000";
const placeholderKvNamespaceId = "00000000000000000000000000000000";
const previewScripts = new Map([
  ["dev", "vite dev --host 0.0.0.0"],
  ["preview", "vite preview --host 0.0.0.0"],
]);

function readConfig(errors) {
  const parseErrors = [];
  const config = parse(
    readFileSync(resolve(rootDir, "wrangler.jsonc"), "utf8"),
    parseErrors,
    { allowTrailingComma: true },
  );
  for (const error of parseErrors) {
    errors.push(
      `wrangler.jsonc has invalid JSONC: ${printParseErrorCode(error.error)} at offset ${error.offset}.`,
    );
  }
  return config;
}

function requireEqual(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(
      `${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`,
    );
  }
}

function verifyWorker(errors, config) {
  requireEqual(
    errors,
    "wrangler.jsonc name",
    config?.name,
    "ghostbuild-cloudflare-app",
  );
  if (
    config?.main !== "src/plain-server.ts" &&
    config?.main !== "src/server.ts"
  ) {
    errors.push(
      'wrangler.jsonc main must be "src/plain-server.ts" or the protected Agent entrypoint "src/server.ts".',
    );
  }
  requireEqual(
    errors,
    "wrangler.jsonc compatibility_date",
    config?.compatibility_date,
    "2026-07-21",
  );
  requireEqual(
    errors,
    "wrangler.jsonc upload_source_maps",
    config?.upload_source_maps,
    true,
  );
  if (!config?.compatibility_flags?.includes("nodejs_compat")) {
    errors.push(
      'wrangler.jsonc compatibility_flags must include "nodejs_compat".',
    );
  }
  errors.push(
    ...findWorkerObservabilityErrors(config, "wrangler.jsonc"),
    ...findWorkerRuntimeSecretErrors(
      config,
      "wrangler.jsonc",
      "configure values as Cloudflare bindings",
    ),
  );

  const d1 = config?.d1_databases?.find((item) => item?.binding === "DB");
  if (!d1) {
    errors.push("wrangler.jsonc must bind D1 as DB.");
  } else {
    requireEqual(
      errors,
      "wrangler.jsonc D1 database_name",
      d1.database_name,
      "ghostbuild-cloudflare-app",
    );
    requireEqual(
      errors,
      "wrangler.jsonc D1 migrations_dir",
      d1.migrations_dir,
      "migrations",
    );
    if (
      !allowUnprovisioned &&
      (!d1.database_id || d1.database_id === placeholderDatabaseId)
    ) {
      errors.push("wrangler.jsonc must contain a provisioned D1 database_id.");
    }
  }

  const agentSecurityD1 = config?.d1_databases?.find(
    (item) => item?.binding === "AGENT_SECURITY_DB",
  );
  const appAgentBinding = config?.durable_objects?.bindings?.find(
    (item) => item?.class_name === "AppAgent",
  );
  const appAgentExport = config?.exports?.AppAgent;
  const appAgentEnabled = Boolean(
    config?.ai ||
    agentSecurityD1 ||
    appAgentBinding ||
    appAgentExport ||
    config?.triggers,
  );
  if (appAgentEnabled && !agentSecurityD1) {
    errors.push(
      "AppAgent requires protected agent security D1 as AGENT_SECURITY_DB.",
    );
  } else if (agentSecurityD1) {
    requireEqual(
      errors,
      "wrangler.jsonc AGENT_SECURITY_DB database_name",
      agentSecurityD1.database_name,
      "ghostbuild-cloudflare-app-agent-security",
    );
    requireEqual(
      errors,
      "wrangler.jsonc AGENT_SECURITY_DB migrations_dir",
      agentSecurityD1.migrations_dir,
      "agent-security-migrations",
    );
    if (
      !allowUnprovisioned &&
      (!agentSecurityD1.database_id ||
        agentSecurityD1.database_id === placeholderDatabaseId)
    ) {
      errors.push(
        "wrangler.jsonc must contain a provisioned AGENT_SECURITY_DB database_id.",
      );
    }
  }
  if (appAgentEnabled) {
    requireEqual(
      errors,
      "wrangler.jsonc ai.binding",
      config?.ai?.binding,
      "AI",
    );
    requireEqual(errors, "wrangler.jsonc main", config?.main, "src/server.ts");
    if (!appAgentBinding) {
      errors.push("AppAgent requires its Durable Object binding.");
    }
    if (
      appAgentExport?.type !== "durable-object" ||
      appAgentExport?.storage !== "sqlite"
    ) {
      errors.push("AppAgent requires its SQLite Durable Object export.");
    }
    if (
      !Array.isArray(config?.triggers?.crons) ||
      config.triggers.crons.length !== 1 ||
      config.triggers.crons[0] !== "0 3 * * *"
    ) {
      errors.push("AppAgent requires its daily security cleanup schedule.");
    }
  }
  if (
    d1?.database_id &&
    d1.database_id !== placeholderDatabaseId &&
    d1.database_id === agentSecurityD1?.database_id
  ) {
    errors.push(
      "wrangler.jsonc DB and AGENT_SECURITY_DB must use separate D1 databases.",
    );
  }
  const d1Bindings = config?.d1_databases;
  if (
    !Array.isArray(d1Bindings) ||
    d1Bindings.length !== (appAgentEnabled ? 2 : 1) ||
    new Set(d1Bindings.map((binding) => binding?.binding)).size !==
      d1Bindings.length ||
    d1Bindings.some(
      (binding) =>
        binding?.binding !== "DB" && binding?.binding !== "AGENT_SECURITY_DB",
    )
  ) {
    errors.push(
      appAgentEnabled
        ? "AppAgent requires exactly the separate DB and AGENT_SECURITY_DB D1 bindings."
        : "wrangler.jsonc must contain exactly the application DB binding.",
    );
  }

  const r2 = config?.r2_buckets?.find(
    (item) => item?.binding === "APP_STORAGE",
  );
  requireEqual(
    errors,
    "wrangler.jsonc R2 bucket_name",
    r2?.bucket_name,
    "ghostbuild-cloudflare-app-storage",
  );
  const kv = config?.kv_namespaces?.find(
    (item) => item?.binding === "APP_CACHE",
  );
  if (
    !kv ||
    !/^[a-f0-9]{32}$/.test(kv.id ?? "") ||
    (!allowUnprovisioned && kv.id === placeholderKvNamespaceId)
  ) {
    errors.push(
      "wrangler.jsonc must contain a provisioned APP_CACHE KV namespace id.",
    );
  }
  if (config?.migrations !== undefined) {
    errors.push(
      "wrangler.jsonc must use declarative Durable Object exports instead of legacy migrations.",
    );
  }
}

function verifyPackage(errors) {
  const pkg = JSON.parse(
    readFileSync(resolve(rootDir, "package.json"), "utf8"),
  );
  const scripts = pkg.scripts ?? {};
  for (const name of [
    "build",
    "cf-typegen",
    "deploy",
    "lint",
    "provision:production",
    "typecheck",
    "verify:production-config",
    "verify:stack",
  ]) {
    if (typeof scripts[name] !== "string") {
      errors.push(`package.json must define scripts.${name}.`);
    }
  }
  errors.push(
    ...findMissingCommandSteps(scripts.deploy, "package.json scripts.deploy", [
      "typecheck",
      "verify:stack",
      "provision:production",
      "verify:production-config",
      "build",
      "lint",
      "d1:migrations:apply:production",
      "wrangler deploy",
    ]),
  );
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      continue;
    }
    const allowedPreview = previewScripts.get(name) === command;
    if (!allowedPreview && startsLocalDevServer(command)) {
      errors.push(
        `package.json script ${JSON.stringify(name)} must not start a local dev server.`,
      );
    }
    if (targetsStaging(name, command)) {
      errors.push(
        `package.json script ${JSON.stringify(name)} must not target staging.`,
      );
    }
    if (loadsLocalEnvFiles(command)) {
      errors.push(
        `package.json script ${JSON.stringify(name)} must not load local env files.`,
      );
    }
  }
}

function verifyProvisioner(errors) {
  const result = spawnSync(
    process.execPath,
    [
      resolve(rootDir, "scripts/provision-cloudflare-production.mjs"),
      "--dry-run",
    ],
    { cwd: rootDir, encoding: "utf8" },
  );
  if (result.status !== 0) {
    errors.push(
      `provision:production --dry-run must succeed: ${(result.stderr || result.stdout).trim()}.`,
    );
  }
}

export function verifyProductionConfig() {
  const errors = [];
  verifyWorker(errors, readConfig(errors));
  verifyPackage(errors);
  verifyProvisioner(errors);
  return errors;
}

export function main() {
  const errors = verifyProductionConfig();
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
