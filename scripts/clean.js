import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const generatedPaths = [
  '.tanstack',
  '.cloudflare',
  '.wrangler',
  'dist',
  'package-lock.json',
  'template/.tanstack',
  'template/.wrangler',
  'template/dist',
  'template/.cloudflare',
];

for (const path of generatedPaths) {
  rmSync(resolve(rootDir, path), { force: true, recursive: true });
}
