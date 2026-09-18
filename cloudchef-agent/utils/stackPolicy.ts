const forbiddenStackDependencyPatterns = [
  /^convex$/,
  /^@convex\//,
  /^remix$/,
  /^@remix-run\//,
  /^openai$/,
  /^@openai\//,
  /^anthropic$/,
  /^@anthropic-ai\/sdk$/,
  /^@google\/genai$/,
  /^@google\/generative-ai$/,
  /^@ai-sdk\/(?!provider$|react$)[^/]+$/,
  /^groq-sdk$/,
  /^@mistralai\/mistralai$/,
];

const REGISTRY_PACKAGE_NAME = String.raw`(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)`;
const REGISTRY_SELECTOR = String.raw`[a-zA-Z0-9._+~^*<>=| -]+`;
const REGISTRY_PACKAGE_SPEC = new RegExp(`^${REGISTRY_PACKAGE_NAME}(?:@${REGISTRY_SELECTOR})?$`);
const REGISTRY_ALIAS_SPEC = new RegExp(
  `^${REGISTRY_PACKAGE_NAME}@npm:${REGISTRY_PACKAGE_NAME}(?:@${REGISTRY_SELECTOR})?$`,
);

/** Restrict generated dependencies to npm-registry package selectors. */
export function isRegistryPackageSpec(spec: string): boolean {
  return REGISTRY_PACKAGE_SPEC.test(spec) || REGISTRY_ALIAS_SPEC.test(spec);
}

export function packageNameFromInstallSpec(spec: string) {
  let normalized = spec.trim();
  const npmAliasIndex = normalized.indexOf('npm:');
  if (npmAliasIndex !== -1) {
    normalized = normalized.slice(npmAliasIndex + 'npm:'.length);
  }

  if (normalized.startsWith('@')) {
    const slashIndex = normalized.indexOf('/');
    return stripVersionSuffix(normalized, slashIndex === -1 ? undefined : slashIndex + 1);
  }

  return stripVersionSuffix(normalized);
}

function stripVersionSuffix(packageSpec: string, fromIndex = 0) {
  const versionIndex = packageSpec.indexOf('@', fromIndex);
  return versionIndex === -1 ? packageSpec : packageSpec.slice(0, versionIndex);
}

export function isForbiddenStackDependencyPackageName(packageName: string) {
  return forbiddenStackDependencyPatterns.some((pattern) => pattern.test(packageName));
}
