import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import {
  APP_REQUIRED_PACKAGES,
  GENERATED_APP_TOOLCHAIN,
  WORKER_REQUIRED_PACKAGES,
  collectSourceEntries,
  findAgentCapabilityDependencyErrors,
  findCloudflareAiPeerCompatibilityErrors,
  findForbiddenDependencies,
  findForbiddenImports,
  findForbiddenRuntimeEnvAccess,
  findBuildApprovalErrors,
  findMissingCommandSteps,
  findMissingDependencies,
  findMissingPaths,
  findRuntimePinErrors,
  projectType,
} from "./lib/project-policy.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseRequiredPaths = [
  "eslint.config.js",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "public/THIRD_PARTY_LICENSES.txt",
  "agent-capability.json",
  "scripts/production-license-policy.json",
  "scripts/enable-agent-capability.mjs",
  "scripts/lib/production-license-artifact.mjs",
  "scripts/verify-production-licenses.mjs",
  "src/server.ts",
  "tsconfig.json",
  "worker-configuration.d.ts",
  "wrangler.jsonc",
];
const webAppRequiredPaths = [
  "agent-security-migrations/0001_agent_security.sql",
  "migrations",
  "scripts/lib/runtime-module-security.ts",
  "src/agents/app-agent.ts",
  "src/plain-server.ts",
  "src/routeTree.gen.ts",
  "src/router.tsx",
  "src/routes/__root.tsx",
  "src/routes/index.tsx",
  "vite.config.ts",
];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(rootDir, path), "utf8"));
}

export function verifyStackAlignment() {
  const errors = [];
  const packageJson = readJson("package.json");
  const capability = readJson("agent-capability.json");
  const wranglerConfig = parse(
    readFileSync(resolve(rootDir, "wrangler.jsonc"), "utf8"),
  );
  const agentCapabilityEnabled =
    wranglerConfig?.main === capability?.wrangler?.main;
  const type = projectType(packageJson);
  if (existsSync(resolve(rootDir, "package-lock.json"))) {
    errors.push(
      "package-lock.json is not allowed; generated projects use the pinned pnpm toolchain only.",
    );
  }
  errors.push(
    ...findForbiddenDependencies(packageJson, "package.json"),
    ...findMissingDependencies(
      packageJson,
      "package.json",
      type === "worker" ? WORKER_REQUIRED_PACKAGES : APP_REQUIRED_PACKAGES,
    ),
    ...findCloudflareAiPeerCompatibilityErrors(packageJson, "package.json"),
    ...findAgentCapabilityDependencyErrors(
      packageJson,
      "package.json",
      capability.dependencies,
      agentCapabilityEnabled,
    ),
    ...findRuntimePinErrors(
      packageJson,
      "package.json",
      GENERATED_APP_TOOLCHAIN,
    ),
    ...findMissingPaths(rootDir, [
      ...baseRequiredPaths,
      ...(type === "web_app" ? webAppRequiredPaths : []),
    ]),
  );

  const workspace = readFileSync(
    resolve(rootDir, "pnpm-workspace.yaml"),
    "utf8",
  );
  errors.push(...findBuildApprovalErrors(workspace, "pnpm-workspace.yaml"));

  const scripts = packageJson.scripts ?? {};
  if (type === "web_app" && scripts.dev !== "vite dev --host 0.0.0.0") {
    errors.push('package.json must define "dev": "vite dev --host 0.0.0.0".');
  }
  if (type === "web_app" && scripts.preview !== "vite preview --host 0.0.0.0") {
    errors.push(
      'package.json must define "preview": "vite preview --host 0.0.0.0".',
    );
  }
  if (type === "worker" && scripts.dev !== "wrangler dev") {
    errors.push('Worker package.json must define "dev": "wrangler dev".');
  }
  if (type === "worker" && scripts.preview !== "wrangler dev") {
    errors.push('Worker package.json must define "preview": "wrangler dev".');
  }
  if (
    type === "worker" &&
    /(?:provision:production|verify:production-config|d1:migrations:apply:production|vite)/.test(
      scripts.deploy ?? "",
    )
  ) {
    errors.push(
      "Worker package.json scripts.deploy must not contain web-app provisioning, migrations, or Vite steps.",
    );
  }
  errors.push(
    ...findMissingCommandSteps(
      scripts.build,
      "package.json scripts.build",
      type === "worker"
        ? ["wrangler deploy", "--dry-run", "--outdir dist/worker"]
        : ["verify:licenses", "vite build", "verify:licenses:built"],
    ),
    ...findMissingCommandSteps(
      scripts.typecheck,
      "package.json scripts.typecheck",
      type === "web_app"
        ? ["generate-routes", "cf-typegen", "tsc"]
        : ["cf-typegen", "tsc"],
    ),
    ...findMissingCommandSteps(scripts.deploy, "package.json scripts.deploy", [
      "typecheck",
      "verify:stack",
      ...(type === "web_app"
        ? ["provision:production", "verify:production-config"]
        : []),
      "build",
      "lint",
      ...(type === "web_app" ? ["d1:migrations:apply:production"] : []),
      "wrangler deploy",
    ]),
  );

  const tsconfig = parse(
    readFileSync(resolve(rootDir, "tsconfig.json"), "utf8"),
  );
  if (tsconfig?.compilerOptions?.noUnusedLocals === false) {
    errors.push("tsconfig.json must not disable noUnusedLocals.");
  }
  if (tsconfig?.compilerOptions?.noUnusedParameters === false) {
    errors.push("tsconfig.json must not disable noUnusedParameters.");
  }

  const files = collectSourceEntries(rootDir, [
    "src",
    ...(type === "web_app"
      ? ["vite.config.ts", "scripts/lib/runtime-module-security.ts"]
      : []),
  ]);
  errors.push(
    ...findForbiddenImports(files),
    ...findForbiddenRuntimeEnvAccess(files),
  );
  return errors;
}

export function main() {
  const errors = verifyStackAlignment();
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
