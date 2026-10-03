import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import {
  CF_GENERATED_BINDING_TYPES,
  CLOUDFLARE_CONFIG_FILE,
  CLOUDFLARE_PROJECT_FILE,
} from "./lib/cloudflare-project.mjs";
import {
  cloudflareConfigErrors,
  readCloudflareProject,
} from "./lib/cloudflare-project-files.mjs";
import {
  APP_REQUIRED_PACKAGES,
  GENERATED_APP_TOOLCHAIN,
  collectSourceEntries,
  findAgentCapabilityDependencyErrors,
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
  CLOUDFLARE_CONFIG_FILE,
  CLOUDFLARE_PROJECT_FILE,
  CF_GENERATED_BINDING_TYPES,
  "scripts/lib/cloudflare-project.mjs",
  "scripts/lib/cloudflare-project-files.mjs",
  "scripts/render-cloudflare-config.mjs",
  "scripts/production-license-policy.json",
  "scripts/enable-agent-capability.mjs",
  "scripts/lib/production-license-artifact.mjs",
  "scripts/verify-production-licenses.mjs",
  "src/server.ts",
  "tsconfig.json",
  "vite.config.ts",
];
const webAppRequiredPaths = [
  "agent-security-migrations/0001_agent_security.sql",
  "migrations",
  "scripts/lib/runtime-module-security.ts",
  "src/agents/app-agent.ts",
  "src/application.ts",
  "src/plain-server.ts",
];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(rootDir, path), "utf8"));
}

export function verifyStackAlignment() {
  const errors = [];
  const packageJson = readJson("package.json");
  const capability = readJson("agent-capability.json");
  const { project, errors: projectErrors } = readCloudflareProject(rootDir);
  errors.push(...projectErrors);
  const agentCapabilityEnabled = Boolean(project.agent);
  if (projectErrors.length === 0) {
    errors.push(...cloudflareConfigErrors(rootDir, project));
  }
  const type = projectType(packageJson);
  if (
    projectErrors.length === 0 &&
    (type === "web_app") !== (project.assets === true)
  ) {
    errors.push(
      type === "web_app"
        ? `A web app must declare "assets": true in ${CLOUDFLARE_PROJECT_FILE} so its pages run through the Worker.`
        : `A Worker-only project must not declare assets in ${CLOUDFLARE_PROJECT_FILE}.`,
    );
  }
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
      APP_REQUIRED_PACKAGES,
    ),
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
  if (scripts.dev !== "vite dev --host 0.0.0.0") {
    errors.push('package.json must define "dev": "vite dev --host 0.0.0.0".');
  }
  if (scripts.preview !== "vite preview --host 0.0.0.0") {
    errors.push(
      'package.json must define "preview": "vite preview --host 0.0.0.0".',
    );
  }
  if (
    type === "worker" &&
    /(?:provision:production|verify:production-config|d1:migrations:apply:production)/.test(
      scripts.deploy ?? "",
    )
  ) {
    errors.push(
      "Worker package.json scripts.deploy must not contain web-app provisioning or migration steps.",
    );
  }
  errors.push(
    ...findMissingCommandSteps(
      scripts.build,
      "package.json scripts.build",
      type === "worker"
        ? ["vite build"]
        : ["verify:licenses", "vite build", "verify:licenses:built"],
    ),
    ...findMissingCommandSteps(
      scripts.typecheck,
      "package.json scripts.typecheck",
      ["cf-typegen", "tsc"],
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
      "cf deploy --prebuilt",
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
    "vite.config.ts",
    ...(type === "web_app" ? ["scripts/lib/runtime-module-security.ts"] : []),
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
