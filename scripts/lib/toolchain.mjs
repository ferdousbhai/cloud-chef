import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * The toolchain the control plane builds with, as pinned in one place each: Node.js by `.nvmrc`, pnpm by
 * `package.json` `packageManager`. Every other check compares against these rather than repeating a version.
 * @param {{ nvmrc: string | undefined; packageManager: string | undefined }} sources
 * @returns {{ node: string | null; pnpm: string | null; errors: string[] }}
 */
export function parsePinnedToolchain({ nvmrc, packageManager }) {
  const errors = [];
  const node = String(nvmrc ?? '').trim();
  if (!EXACT_VERSION.test(node)) {
    errors.push(`.nvmrc must pin an exact Node.js version; found ${JSON.stringify(node)}.`);
  }
  const pnpm = /^pnpm@(.+)$/.exec(String(packageManager ?? ''))?.[1] ?? '';
  if (!EXACT_VERSION.test(pnpm)) {
    errors.push(`package.json packageManager must pin an exact pnpm version; found ${JSON.stringify(packageManager)}.`);
  }
  return { node: EXACT_VERSION.test(node) ? node : null, pnpm: EXACT_VERSION.test(pnpm) ? pnpm : null, errors };
}

/** The pinned toolchain of this checkout; throws when either pin is not an exact version. */
export function readPinnedToolchain() {
  const { node, pnpm, errors } = parsePinnedToolchain({
    nvmrc: readFileSync(resolve(rootDir, '.nvmrc'), 'utf8'),
    packageManager: JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')).packageManager,
  });
  if (node === null || pnpm === null) {
    throw new Error(errors.join(' '));
  }
  return { node, pnpm };
}
