import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";
import {
  readCloudflareProject,
  writeCloudflareProject,
} from "./lib/cloudflare-project-files.mjs";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readCapability(rootDir) {
  return JSON.parse(
    await readFile(resolve(rootDir, "agent-capability.json"), "utf8"),
  );
}

/**
 * Enable the protected Agent/Workers AI capability without hand-editing four configuration
 * surfaces. Dependencies are installed separately, at their latest release, by
 * {@link installAgentCapabilityDependencies}.
 */
export async function enableAgentCapability(rootDir = scriptRoot) {
  const capability = await readCapability(rootDir);

  const licensePolicyPath = resolve(
    rootDir,
    "scripts/production-license-policy.json",
  );
  const licensePolicy = JSON.parse(await readFile(licensePolicyPath, "utf8"));
  licensePolicy.metadataOnlyPackageAllowlist = [
    ...new Set([
      ...(licensePolicy.metadataOnlyPackageAllowlist ?? []),
      ...capability.metadataOnlyPackageAllowlist,
    ]),
  ].sort((left, right) => left.localeCompare(right));
  await writeFile(
    licensePolicyPath,
    `${JSON.stringify(licensePolicy, null, 2)}\n`,
  );

  const { project, errors } = readCloudflareProject(rootDir);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  writeCloudflareProject(rootDir, {
    ...project,
    entrypoint: capability.cloudflare.entrypoint,
    agent: project.agent ?? capability.cloudflare.agent,
  });

  const tsconfigPath = resolve(rootDir, "tsconfig.json");
  let tsconfigSource = await readFile(tsconfigPath, "utf8");
  const tsconfig = parse(tsconfigSource);
  const exclusions = (tsconfig.exclude ?? []).filter(
    (path) => !capability.typescriptExcludesToRemove.includes(path),
  );
  tsconfigSource = applyEdits(
    tsconfigSource,
    modify(
      tsconfigSource,
      ["exclude"],
      exclusions.length > 0 ? exclusions : undefined,
      {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      },
    ),
  );
  await writeFile(tsconfigPath, tsconfigSource);
}

/** Install every capability dependency at its latest release; the lockfile pins what resolved. */
export async function installAgentCapabilityDependencies(rootDir = scriptRoot) {
  const capability = await readCapability(rootDir);
  const result = spawnSync(
    "pnpm",
    ["add", ...capability.dependencies.map((name) => `${name}@latest`)],
    { cwd: rootDir, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("Installing the Agent capability dependencies failed.");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await enableAgentCapability();
  await installAgentCapabilityDependencies();
}
