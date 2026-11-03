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

export function collectSourceEntries(
  rootDir,
  entries,
  extensions = sourceExtensions,
) {
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
    } else if (extensions.has(extname(path))) {
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

/** The pages the app serves, which is where a remote script tag or import map would go. */
export function collectHtmlEntries(rootDir, entries) {
  return collectSourceEntries(rootDir, entries, new Set([".html"]));
}

/**
 * A script loaded from another site runs with the app's origin: whoever controls that site, or takes it
 * over, can read and change everything the app's pages can. Libraries are installed with pnpm and bundled,
 * so they ship pinned with the app. Turnstile is the exception: Cloudflare serves it only from
 * challenges.cloudflare.com.
 */
const remoteScriptLoads = [
  {
    pattern:
      /<script\b[^>]*\bsrc\s*=\s*\{?\s*["'`]?(?:https?:)?\/\/(?!challenges\.cloudflare\.com\/)/i,
    message:
      "loads a script from another site; install the library with pnpm so it is bundled with the app.",
  },
  {
    pattern: /\btype\s*[=:]\s*\{?\s*["'`]importmap["'`]/i,
    message:
      "declares an import map, which resolves modules from other sites at runtime; install them with pnpm instead.",
  },
  {
    pattern: /(?:\bimport\s*\(\s*|\bfrom\s*|\bimport\s*)["'`](?:https?:)?\/\//,
    message:
      "imports a module from another site at runtime; install it with pnpm so it is bundled with the app.",
  },
  {
    pattern:
      /\/\/(?:[\w-]+\.)*(?:esm\.sh|jsdelivr\.net|unpkg\.com|skypack\.dev|jspm\.(?:io|dev))\b/i,
    message:
      "references a JavaScript CDN; install the package with pnpm so it is bundled with the app.",
  },
  {
    pattern:
      /googletagmanager\.com|google-analytics\.com\/(?:analytics|ga)\.js|cloudflareinsights\.com|\bgtag\s*\(|\bdataLayer\.push\s*\(/i,
    message:
      "adds a third-party analytics tag, which runs that vendor's code with the app's origin; send events from the Worker instead.",
  },
];

export function findRemoteScriptLoads(files) {
  return remoteScriptLoads.flatMap(({ pattern, message }) =>
    findLineViolations(files, (line) => pattern.test(line), message),
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
