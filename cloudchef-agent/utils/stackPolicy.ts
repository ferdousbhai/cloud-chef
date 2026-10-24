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
