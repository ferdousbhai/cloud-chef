import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const forbiddenImportPatterns = [
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:convex(?:\/[^'"]*)?|@convex\/[^'"]*)['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:remix(?:\/[^'"]*)?|@remix-run\/[^'"]*)['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:openai(?:\/[^'"]*)?|@openai\/[^'"]*)['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:anthropic(?:\/[^'"]*)?|@anthropic-ai\/sdk)['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"]@google\/(?:genai|generative-ai)['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"]@ai-sdk\/(?!provider(?:\/|['"])|react(?:\/|['"]))[^'"]*['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:groq-sdk|@mistralai\/mistralai)['"]/,
];

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

export function findForbiddenImports(files) {
  return findLineViolations(
    files,
    (line) => forbiddenImportPatterns.some((pattern) => pattern.test(line)),
    "imports a forbidden provider/framework module.",
  );
}

export function findForbiddenRuntimeEnvAccess(files, allowlist = []) {
  const patterns = [/\bprocess\.env\b/, /\bimport\.meta\.env\b/];
  const errors = [];
  for (const file of files) {
    const normalizedFile = file.replaceAll("\\", "/");
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (!patterns.some((pattern) => pattern.test(line))) {
          return;
        }
        const allowed = allowlist.some(
          ({ pathSuffix, snippet }) =>
            normalizedFile.endsWith(pathSuffix) && line.includes(snippet),
        );
        if (!allowed) {
          errors.push(
            `${file}:${index + 1} must read runtime config from Cloudflare Worker bindings, not process.env or import.meta.env.`,
          );
        }
      });
  }
  return errors;
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
