const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const forbiddenDependencyPatterns = [
  /^convex$/,
  /^@convex\//,
  /^remix$/,
  /^@remix-run\//,
  /^openai$/,
  /^@openai\//,
  /^anthropic$/,
  /^@anthropic-ai\/sdk$/,
  /^@google\/(?:genai|generative-ai)$/,
  /^@ai-sdk\/(?!provider$|react$)[^/]+$/,
  /^groq-sdk$/,
  /^@mistralai\/mistralai$/,
  /^@types\/diff$/,
];

/** The control plane builds on Workers Builds with the pinned Node 26. */
export const CONTROL_PLANE_TOOLCHAIN = {
  nodeEngine: ">=26.0.0",
  nodeTypesMajor: 26,
};
/**
 * Generated apps build inside the user's workspace container, whose stock sandbox image ships
 * Node 22. 22.13 is the floor of the template's toolchain (ESLint). Node types track the same
 * major so scripts cannot compile against APIs the container lacks.
 */
export const GENERATED_APP_TOOLCHAIN = {
  nodeEngine: ">=22.13.0",
  nodeTypesMajor: 22,
};
export const REQUIRED_PNPM_VERSION = "11.14.0";

/** Toolchain packages the control plane and generated apps share, kept on aligned versions. */
export const SHARED_APP_PACKAGES = ["typescript", "vite"];

/**
 * Every generated project builds and deploys with Vite, the Cloudflare Vite plugin, and the cf CLI,
 * as the control plane does. A web framework is the project's own choice, never required.
 */
export const APP_REQUIRED_PACKAGES = [
  ...SHARED_APP_PACKAGES,
  "@cloudflare/vite-plugin",
  "cf",
];

export function projectType(pkg) {
  return pkg?.cloudchef?.projectType === "worker" ? "worker" : "web_app";
}

export function dependencyNames(pkg) {
  return new Set(
    dependencySections.flatMap((section) => {
      const values = pkg?.[section];
      return values && typeof values === "object" ? Object.keys(values) : [];
    }),
  );
}

export function packageDependencyVersion(pkg, name) {
  for (const section of dependencySections) {
    const version = pkg?.[section]?.[name];
    if (typeof version === "string") {
      return version;
    }
  }
  return undefined;
}

export function findForbiddenDependencies(pkg, label) {
  return [...dependencyNames(pkg)]
    .filter((name) =>
      forbiddenDependencyPatterns.some((pattern) => pattern.test(name)),
    )
    .map(
      (name) =>
        `${label} must not depend on ${name}; use Cloudflare Workers AI and TanStack/Cloudflare APIs.`,
    );
}

export function findMissingDependencies(pkg, label, requiredPackages) {
  const names = dependencyNames(pkg);
  return requiredPackages
    .filter((name) => !names.has(name))
    .map(
      (name) =>
        `${label} must include ${name} for the TanStack Start + Cloudflare stack.`,
    );
}

export function findPackageVersionAlignmentErrors(
  referencePkg,
  pkg,
  label,
  packageNames,
) {
  return packageNames.flatMap((name) => {
    const expected = packageDependencyVersion(referencePkg, name);
    const actual = packageDependencyVersion(pkg, name);
    return expected && actual && actual !== expected
      ? [
          `${label} must align ${name} with package.json ${expected}; found ${actual}.`,
        ]
      : [];
  });
}

export function findAgentCapabilityDependencyErrors(
  pkg,
  label,
  requiredDependencies,
  enabled,
) {
  if (!enabled) {
    return [];
  }
  return requiredDependencies.flatMap((name) =>
    packageDependencyVersion(pkg, name)
      ? []
      : [`${label} must declare enabled Agent capability dependency ${name}.`],
  );
}

export function findRuntimePinErrors(pkg, label, toolchain) {
  const errors = [];
  if (pkg?.engines?.node !== toolchain.nodeEngine) {
    errors.push(`${label} must set engines.node to ${toolchain.nodeEngine}.`);
  }
  if (pkg?.packageManager !== `pnpm@${REQUIRED_PNPM_VERSION}`) {
    errors.push(
      `${label} must pin packageManager to pnpm@${REQUIRED_PNPM_VERSION}.`,
    );
  }
  if (
    !pkg?.devDependencies?.["@types/node"]?.startsWith(
      `^${toolchain.nodeTypesMajor}.`,
    )
  ) {
    errors.push(
      `${label} must use @types/node ^${toolchain.nodeTypesMajor}.x for the Node ${toolchain.nodeTypesMajor} toolchain.`,
    );
  }
  return errors;
}
