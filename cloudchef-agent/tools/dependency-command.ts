import { isRegistryPackageSpec } from '../utils/stackPolicy.js';

type DependencyCommand = {
  mode: 'add' | 'sync-lockfile';
  packages: string[];
};

function words(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/** Throws unless every package an install names comes from the npm registry. */
function requireRegistryPackages(specs: readonly string[]): void {
  const nonRegistrySpecs = specs.filter((spec) => !isRegistryPackageSpec(spec));
  if (nonRegistrySpecs.length > 0) {
    throw new Error(`Only npm registry package names and versions are allowed: ${nonRegistrySpecs.join(', ')}.`);
  }
}

/**
 * The dependency change an `exec` asks for, or null when the command runs as an ordinary command.
 * `pnpm add` and `pnpm install --lockfile-only` are resolved in a staging copy with install scripts
 * off and only package.json and the lockfile written back; any other install that names a package
 * must name one from the npm registry.
 */
export function parseDependencyCommand(command: string): DependencyCommand | null {
  const normalized = command.trim();
  if (normalized === 'pnpm install --lockfile-only') {
    return { mode: 'sync-lockfile', packages: [] };
  }
  if (normalized.startsWith('pnpm add ')) {
    const packages = words(normalized.slice('pnpm add '.length));
    requireRegistryPackages(packages);
    return { mode: 'add', packages };
  }
  const install = /^(?:pnpm|npm|yarn|bun)\s+(?:add|install|i)\s+(.+)$/.exec(normalized);
  if (install) {
    const installed = install[1]!.split(/&&|\|\||[;|&\n]/)[0]!;
    requireRegistryPackages(words(installed).filter((word) => !word.startsWith('-')));
  }
  return null;
}
