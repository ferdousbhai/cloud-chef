import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A repository file's JSON, or undefined with the reason added to `errors`. */
export function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(resolve(rootDir, path), 'utf8'));
  } catch (error) {
    errors.push(`${path} must be valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
    return undefined;
  }
}

export function requireEqual(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`);
  }
}
