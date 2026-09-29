import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLOUDFLARE_CONFIG_FILE,
  CLOUDFLARE_PROJECT_FILE,
  parseCloudflareProjectText,
  renderCloudflareConfig,
} from "./cloudflare-project.mjs";

export function readCloudflareProject(rootDir) {
  let text;
  try {
    text = readFileSync(resolve(rootDir, CLOUDFLARE_PROJECT_FILE), "utf8");
  } catch (error) {
    return {
      project: {},
      errors: [
        `${CLOUDFLARE_PROJECT_FILE} could not be read: ${error.message}`,
      ],
    };
  }
  return parseCloudflareProjectText(text);
}

/** Write the project data and the configuration rendered from it together, so they never drift. */
export function writeCloudflareProject(rootDir, project) {
  writeIfChanged(
    resolve(rootDir, CLOUDFLARE_PROJECT_FILE),
    `${JSON.stringify(project, null, 2)}\n`,
  );
  renderCloudflareConfigFile(rootDir, project);
}

/**
 * Regenerate cloudflare.config.ts, leaving it untouched when current: the Vite plugin restarts a
 * running dev server on any write to its config, even one with identical content.
 */
export function renderCloudflareConfigFile(rootDir, project) {
  writeIfChanged(
    resolve(rootDir, CLOUDFLARE_CONFIG_FILE),
    renderCloudflareConfig(project),
  );
}

function writeIfChanged(path, content) {
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
    writeFileSync(path, content);
  }
}

export function cloudflareConfigErrors(rootDir, project) {
  const configPath = resolve(rootDir, CLOUDFLARE_CONFIG_FILE);
  return existsSync(configPath) &&
    readFileSync(configPath, "utf8") === renderCloudflareConfig(project)
    ? []
    : [
        `${CLOUDFLARE_CONFIG_FILE} is out of date; run pnpm run typecheck to regenerate it.`,
      ];
}

/** Run the project's pinned cf CLI directly, without a package-manager start-up per call. */
export function runCf(rootDir, args, stdio = "pipe") {
  return spawnSync(resolve(rootDir, "node_modules/.bin/cf"), args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
  });
}
