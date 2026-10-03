import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLicenseArtifact,
  findProductionLicenseErrors,
  readProductionPackages,
} from "./lib/production-license-artifact.mjs";

import { CF_BUILT_ASSETS_DIR } from "./lib/cloudflare-project.mjs";
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeModulesPath = resolve(rootDir, "node_modules");
const policyPath = resolve(rootDir, "scripts/production-license-policy.json");
const lockfilePath = resolve(rootDir, "pnpm-lock.yaml");
const artifactPath = resolve(rootDir, "public/THIRD_PARTY_LICENSES.txt");
const builtArtifactPath = resolve(
  rootDir,
  `${CF_BUILT_ASSETS_DIR}/THIRD_PARTY_LICENSES.txt`,
);

function readLicenseReport() {
  const result = spawnSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `pnpm production license inventory failed: ${result.stderr?.trim() || `exit ${result.status}`}`,
    );
  }
  // A project with no production dependencies gets a sentence, not JSON.
  return /^No licenses/i.test(result.stdout.trim())
    ? {}
    : JSON.parse(result.stdout);
}

function verify() {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const lockfile = readFileSync(lockfilePath, "utf8");
  const packages = readProductionPackages(readLicenseReport(), nodeModulesPath);
  const expectedArtifact = createLicenseArtifact(packages, policy, lockfile);
  const errors = findProductionLicenseErrors(packages, policy);
  if (!existsSync(artifactPath)) {
    errors.push(
      "public/THIRD_PARTY_LICENSES.txt is missing; run pnpm run licenses:generate.",
    );
  } else if (readFileSync(artifactPath, "utf8") !== expectedArtifact) {
    errors.push(
      "public/THIRD_PARTY_LICENSES.txt is stale; run pnpm run licenses:generate.",
    );
  }
  return { errors, expectedArtifact, packages };
}

try {
  const [mode, ...extra] = process.argv.slice(2);
  if (
    extra.length > 0 ||
    (mode !== undefined && !["--write-notices", "--built"].includes(mode))
  ) {
    throw new Error(
      "Usage: node scripts/verify-production-licenses.mjs [--write-notices|--built]",
    );
  }
  const result = verify();
  const substantiveErrors = result.errors.filter(
    (error) => !error.startsWith("public/THIRD_PARTY_LICENSES.txt is "),
  );
  if (mode === "--write-notices" && substantiveErrors.length === 0) {
    writeFileSync(artifactPath, result.expectedArtifact);
    console.log(
      `Wrote public/THIRD_PARTY_LICENSES.txt for ${result.packages.length} production packages.`,
    );
  } else if (result.errors.length > 0) {
    throw new Error(result.errors.map((error) => `- ${error}`).join("\n"));
  } else if (mode === "--built") {
    if (
      !existsSync(builtArtifactPath) ||
      readFileSync(builtArtifactPath, "utf8") !== result.expectedArtifact
    ) {
      throw new Error(
        "The built THIRD_PARTY_LICENSES.txt asset must exactly match the generated public artifact.",
      );
    }
    console.log("Verified the deployed generated-app license artifact.");
  } else {
    console.log(
      `Reviewed generated-app production licenses: ${result.packages.length} packages.`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
