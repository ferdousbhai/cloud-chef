import { z } from 'zod';
import {
  isForbiddenStackDependencyPackageName,
  isRegistryPackageSpec,
  packageNameFromInstallSpec,
} from '../utils/stackPolicy.js';

export function splitPackageSpecs(packages: string) {
  return packages.trim().split(/\s+/).filter(Boolean);
}

export function findForbiddenNpmInstallPackages(packages: string) {
  return splitPackageSpecs(packages)
    .map((spec) => ({ spec, packageName: packageNameFromInstallSpec(spec) }))
    .filter(({ packageName }) => isForbiddenStackDependencyPackageName(packageName));
}

function findInvalidNpmInstallSpecs(packages: string) {
  return splitPackageSpecs(packages).filter((spec) => spec.startsWith('-'));
}

export const npmInstallToolParameters = z
  .object({
    mode: z.enum(['add', 'sync-lockfile']).optional(),
    packages: z.string().trim().max(2_000).optional(),
  })
  .superRefine((input, ctx) => {
    const mode = input.mode ?? 'add';
    if (mode === 'sync-lockfile') {
      if (input.packages) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['packages'],
          message: 'Package names are not allowed when synchronizing the lockfile.',
        });
      }
      return;
    }
    if (!input.packages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packages'],
        message: 'At least one package is required in add mode.',
      });
      return;
    }
    const packages = input.packages;
    if (splitPackageSpecs(packages).length > 50) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packages'],
        message: 'Install at most 50 packages in one dependency command.',
      });
    }
    const invalidSpecs = findInvalidNpmInstallSpecs(packages);
    if (invalidSpecs.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `pnpm flags are not allowed in dependency package specs: ${invalidSpecs.join(', ')}`,
      });
    }
    const nonRegistrySpecs = splitPackageSpecs(packages).filter((spec) => !isRegistryPackageSpec(spec));
    if (nonRegistrySpecs.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packages'],
        message: `Only npm registry package names and versions are allowed: ${nonRegistrySpecs.join(', ')}.`,
      });
    }

    const forbiddenPackages = findForbiddenNpmInstallPackages(packages);
    if (forbiddenPackages.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsupported package(s): ${forbiddenPackages
          .map(({ spec }) => spec)
          .join(', ')}. Use Cloudflare Workers AI and TanStack/Cloudflare APIs instead.`,
      });
    }
  });

export type ParsedNpmInstallCommand = {
  mode: 'add' | 'sync-lockfile';
  packages: string[];
};

/** Parse the small, safe dependency-command subset accepted by the exec tool. */
export function parseNpmInstallCommand(command: string): ParsedNpmInstallCommand | null {
  const normalized = command.trim();
  if (normalized === 'pnpm install --lockfile-only') {
    return { mode: 'sync-lockfile', packages: [] };
  }
  if (normalized.startsWith('pnpm add ')) {
    const packagesText = normalized.slice('pnpm add '.length);
    npmInstallToolParameters.parse({ mode: 'add', packages: packagesText });
    return { mode: 'add', packages: splitPackageSpecs(packagesText) };
  }
  if (/^(?:pnpm|npm|yarn|bun)\s+(?:add|install|remove|uninstall|update|up)\b/.test(normalized)) {
    throw new Error('exec accepts only `pnpm add <packages>` or `pnpm install --lockfile-only` for dependencies.');
  }
  return null;
}
