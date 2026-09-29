import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLOUDFLARE_PROJECT_FILE,
  PLACEHOLDER_D1_DATABASE_ID,
  PLACEHOLDER_KV_NAMESPACE_ID,
} from "./lib/cloudflare-project.mjs";
import { readCloudflareProject } from "./lib/cloudflare-project-files.mjs";
import {
  findMissingCommandSteps,
  loadsLocalEnvFiles,
  startsLocalDevServer,
  targetsStaging,
} from "./lib/project-policy.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowUnprovisioned = process.argv.includes("--allow-unprovisioned");
const previewScripts = new Map([
  ["dev", "vite dev --host 0.0.0.0"],
  ["preview", "vite preview --host 0.0.0.0"],
]);

function requireEqual(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(
      `${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`,
    );
  }
}

function verifyWorker(errors) {
  const { project, errors: projectErrors } = readCloudflareProject(rootDir);
  errors.push(...projectErrors);
  if (projectErrors.length > 0) {
    return;
  }
  requireEqual(
    errors,
    `${CLOUDFLARE_PROJECT_FILE} name`,
    project.name,
    "cloudchef-cloudflare-app",
  );
  if (!project.d1) {
    errors.push(`${CLOUDFLARE_PROJECT_FILE} must bind D1 as DB.`);
  } else {
    requireEqual(
      errors,
      `${CLOUDFLARE_PROJECT_FILE} d1.name`,
      project.d1.name,
      "cloudchef-cloudflare-app",
    );
    if (!allowUnprovisioned && project.d1.id === PLACEHOLDER_D1_DATABASE_ID) {
      errors.push(
        `${CLOUDFLARE_PROJECT_FILE} must contain a provisioned D1 database id.`,
      );
    }
  }
  const agentSecurityD1 = project.agent?.securityD1;
  if (agentSecurityD1) {
    requireEqual(
      errors,
      `${CLOUDFLARE_PROJECT_FILE} agent.securityD1.name`,
      agentSecurityD1.name,
      "cloudchef-cloudflare-app-agent-security",
    );
    if (
      !allowUnprovisioned &&
      agentSecurityD1.id === PLACEHOLDER_D1_DATABASE_ID
    ) {
      errors.push(
        `${CLOUDFLARE_PROJECT_FILE} must contain a provisioned agent security D1 database id.`,
      );
    }
  }
  requireEqual(
    errors,
    `${CLOUDFLARE_PROJECT_FILE} r2.name`,
    project.r2?.name,
    "cloudchef-cloudflare-app-storage",
  );
  if (
    !project.kv ||
    (!allowUnprovisioned && project.kv.id === PLACEHOLDER_KV_NAMESPACE_ID)
  ) {
    errors.push(
      `${CLOUDFLARE_PROJECT_FILE} must contain a provisioned APP_CACHE KV namespace id.`,
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
      "cf deploy --prebuilt",
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

export function verifyProductionConfig() {
  const errors = [];
  verifyWorker(errors);
  verifyPackage(errors);
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
