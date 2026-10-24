import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const sourceExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const ignoredDirectories = new Set([
  ".cloudflare",
  ".git",
  ".turbo",
  ".wrangler",
  "dist",
  "fixtures",
  "node_modules",
]);

export function collectSourceEntries(rootDir, entries) {
  const files = [];

  function visit(path) {
    if (!existsSync(path)) {
      return;
    }
    const name = path.split(/[\\/]/).pop();
    if (name && ignoredDirectories.has(name)) {
      return;
    }
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path)) {
        visit(join(path, child));
      }
    } else if (sourceExtensions.has(extname(path))) {
      files.push(path);
    }
  }

  for (const entry of entries) {
    visit(resolve(rootDir, entry));
  }
  return files;
}

/**
 * Vite writes each `import.meta.env` value into the built files, so a value read that way in browser
 * code is published with them. Vite's own build flags (DEV, PROD, SSR, MODE, BASE_URL) hold nothing
 * secret. `process.env` is not checked: under `nodejs_compat` with the template's compatibility date,
 * Workers fill it at runtime from the Worker's variables and secrets.
 */
const buildTimeEnvAccess =
  /\bimport\.meta\.env\b(?!\.(?:DEV|PROD|SSR|MODE|BASE_URL)\b)/;

export function findBuildTimeEnvAccess(files) {
  return findLineViolations(
    files,
    (line) => buildTimeEnvAccess.test(line),
    "reads import.meta.env, which is written into the published browser files at build time; read configuration and secrets from the Worker's bindings.",
  );
}

export function findMissingPaths(rootDir, paths) {
  return paths
    .filter((path) => !existsSync(resolve(rootDir, path)))
    .map((path) => `${path} must exist.`);
}

export function findForbiddenPaths(rootDir, paths, reason) {
  return paths
    .filter((path) => existsSync(resolve(rootDir, path)))
    .map((path) => `${path} must not exist; ${reason}.`);
}

function findLineViolations(files, predicate, message) {
  const errors = [];
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (predicate(line)) {
          errors.push(`${file}:${index + 1} ${message}`);
        }
      });
  }
  return errors;
}
