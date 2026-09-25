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

const REQUIRED_AI_SDK_VERSIONS = {
  ai: "7.0.48",
  "@ai-sdk/react": "4.0.51",
};

export const APP_REQUIRED_PACKAGES = [
  "@cloudflare/vite-plugin",
  "@tanstack/react-router",
  "@tanstack/react-start",
  "@tanstack/router-cli",
  "@vitejs/plugin-react",
  "react",
  "react-dom",
  "typescript",
  "vite",
  "wrangler",
];

export const WORKER_REQUIRED_PACKAGES = ["typescript", "wrangler"];

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

export function findCloudflareAiPeerCompatibilityErrors(pkg, label) {
  const peers = ["agents", "@cloudflare/ai-chat"].filter((name) =>
    packageDependencyVersion(pkg, name),
  );
  if (peers.length === 0) {
    return [];
  }

  return Object.entries(REQUIRED_AI_SDK_VERSIONS).flatMap(
    ([name, expected]) => {
      const version = packageDependencyVersion(pkg, name);
      return version && version !== expected
        ? [
            `${label} must pin the tested AI SDK 7 family ${name}@${expected} for ${peers.join(
              ", ",
            )}; found ${version}.`,
          ]
        : [];
    },
  );
}

export function findAgentCapabilityDependencyErrors(
  pkg,
  label,
  expectedDependencies,
  enabled,
) {
  if (!enabled) {
    return [];
  }
  return Object.entries(expectedDependencies).flatMap(([name, expected]) => {
    const actual = packageDependencyVersion(pkg, name);
    return actual === expected
      ? []
      : [
          `${label} must pin enabled Agent capability dependency ${name}@${expected}; found ${actual ?? "missing"}.`,
        ];
  });
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
