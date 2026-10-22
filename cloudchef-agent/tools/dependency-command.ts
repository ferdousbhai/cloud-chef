import { z } from 'zod';
import {
  isForbiddenStackDependencyPackageName,
  isRegistryPackageSpec,
  packageNameFromInstallSpec,
} from '../utils/stackPolicy.js';

function splitPackageSpecs(packages: string): string[] {
  return packages.trim().split(/\s+/).filter(Boolean);
}

/**
 * The packages of a `pnpm add`: at most 50 npm registry specs (which no flag is), none the stack
 * policy forbids.
 */
const packageSpecsSchema = z
  .string()
  .trim()
  .min(1, 'At least one package is required.')
  .max(2_000)
  .superRefine((packages, ctx) => {
    const specs = splitPackageSpecs(packages);
    if (specs.length > 50) {
      ctx.addIssue({ code: 'custom', message: 'Install at most 50 packages in one dependency command.' });
    }
    const nonRegistrySpecs = specs.filter((spec) => !isRegistryPackageSpec(spec));
    if (nonRegistrySpecs.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `Only npm registry package names and versions are allowed: ${nonRegistrySpecs.join(', ')}.`,
      });
    }
    const forbiddenSpecs = specs.filter((spec) =>
      isForbiddenStackDependencyPackageName(packageNameFromInstallSpec(spec)),
    );
    if (forbiddenSpecs.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `Unsupported package(s): ${forbiddenSpecs.join(', ')}. Use Cloudflare Workers AI and Cloudflare platform APIs instead.`,
      });
    }
  });

type DependencyCommand = {
  mode: 'add' | 'sync-lockfile';
  packages: string[];
};

/**
 * The dependency command an `exec` asks for, from the small, safe subset it accepts, or null when the
 * command is not a dependency command. Any other package-manager command throws.
 */
export function parseDependencyCommand(command: string): DependencyCommand | null {
  const normalized = command.trim();
  if (normalized === 'pnpm install --lockfile-only') {
    return { mode: 'sync-lockfile', packages: [] };
  }
  if (normalized.startsWith('pnpm add ')) {
    return { mode: 'add', packages: splitPackageSpecs(packageSpecsSchema.parse(normalized.slice('pnpm add '.length))) };
  }
  if (/^(?:pnpm|npm|yarn|bun)\s+(?:add|install|remove|uninstall|update|up)\b/.test(normalized)) {
    throw new Error('exec accepts only `pnpm add <packages>` or `pnpm install --lockfile-only` for dependencies.');
  }
  return null;
}
