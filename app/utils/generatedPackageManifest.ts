import { z } from 'zod';
import {
  isForbiddenStackDependencyPackageName,
  isRegistryPackageSpec,
  packageNameFromInstallSpec,
} from 'cloudchef-agent/utils/stackPolicy';
import { slashPath } from './pathNames';

const packageDependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const forbiddenPackageManagerPolicyFields = ['dependenciesMeta', 'overrides', 'pnpm', 'resolutions'] as const;

type PackageDependencySection = (typeof packageDependencySections)[number];

/**
 * A dependency map as authored. A version spec the manifest wrote as something other than a
 * string normalizes to `null` rather than failing the section, so it can still be reported by
 * name instead of silently skipping every sibling dependency.
 */
const dependencySectionSchema = z.record(z.string(), z.string().nullable().catch(null));
const optionalDependencySectionSchema = dependencySectionSchema.optional().catch(undefined);

/** Unrecognized members are kept so the package-manager policy fields below remain visible. */
const packageManifestSchema = z.looseObject({
  dependencies: optionalDependencySectionSchema,
  devDependencies: optionalDependencySectionSchema,
  optionalDependencies: optionalDependencySectionSchema,
  peerDependencies: optionalDependencySectionSchema,
});

type PackageManifest = z.infer<typeof packageManifestSchema>;

type ForbiddenGeneratedPackageDependency = {
  section: PackageDependencySection;
  packageName: string;
};

type InvalidGeneratedPackageSource = {
  section: PackageDependencySection;
  packageName: string;
  versionSpec: string | null;
};

function packageJsonPath(filePath: string) {
  return slashPath(filePath).endsWith('/package.json') || filePath === 'package.json';
}

export function findForbiddenGeneratedPackageDependencies(manifest: PackageManifest) {
  const forbiddenDependencies: ForbiddenGeneratedPackageDependency[] = [];

  for (const section of packageDependencySections) {
    for (const [packageName, versionSpec] of Object.entries(manifest[section] ?? {})) {
      if (isForbiddenStackDependencyPackageName(packageName)) {
        forbiddenDependencies.push({ section, packageName });
        continue;
      }

      if (versionSpec === null || !versionSpec.includes('npm:')) {
        continue;
      }

      const aliasedPackageName = packageNameFromInstallSpec(versionSpec);
      if (isForbiddenStackDependencyPackageName(aliasedPackageName)) {
        forbiddenDependencies.push({ section, packageName: aliasedPackageName });
      }
    }
  }

  return forbiddenDependencies;
}

export function findInvalidGeneratedPackageSources(manifest: PackageManifest) {
  const invalidSources: InvalidGeneratedPackageSource[] = [];
  for (const section of packageDependencySections) {
    for (const [packageName, versionSpec] of Object.entries(manifest[section] ?? {})) {
      if (versionSpec === null || !isRegistryPackageSpec(`${packageName}@${versionSpec}`)) {
        invalidSources.push({ section, packageName, versionSpec });
      }
    }
  }
  return invalidSources;
}

export function findForbiddenGeneratedPackageManagerPolicyFields(manifest: PackageManifest) {
  return forbiddenPackageManagerPolicyFields.filter((field) => Object.hasOwn(manifest, field));
}

export function assertValidGeneratedPackageJson(filePath: string, content: string) {
  if (!packageJsonPath(filePath)) {
    return;
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(content);
  } catch {
    return;
  }

  const parsed = packageManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    return;
  }
  const manifest = parsed.data;

  const forbiddenDependencies = findForbiddenGeneratedPackageDependencies(manifest);
  if (forbiddenDependencies.length > 0) {
    const formattedDependencies = forbiddenDependencies
      .map(({ section, packageName }) => `${section}.${packageName}`)
      .join(', ');
    throw new Error(
      `Generated package.json must not depend on ${formattedDependencies}. Use Cloudflare Workers AI and TanStack/Cloudflare APIs instead.`,
    );
  }

  const invalidSources = findInvalidGeneratedPackageSources(manifest);
  if (invalidSources.length > 0) {
    const formattedDependencies = invalidSources
      .map(({ section, packageName }) => `${section}.${packageName}`)
      .join(', ');
    throw new Error(
      `Generated package.json dependencies must use npm registry versions: ${formattedDependencies}. URL, Git, file, link, and workspace sources are not allowed.`,
    );
  }

  const forbiddenPolicyFields = findForbiddenGeneratedPackageManagerPolicyFields(manifest);
  if (forbiddenPolicyFields.length > 0) {
    throw new Error(
      `Generated package.json must not override dependency resolution or build policy through: ${forbiddenPolicyFields.join(', ')}. Use the reviewed pnpm-workspace.yaml policy and npm registry dependency versions instead.`,
    );
  }
}
