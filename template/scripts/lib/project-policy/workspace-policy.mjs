import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";
import generatedProjectDependencyPolicy from "./generated-project-dependency-policy.json" with { type: "json" };

export const GENERATED_PROJECT_DEPENDENCY_POLICY =
  generatedProjectDependencyPolicy;
export const APPROVED_BUILD_DEPENDENCIES =
  generatedProjectDependencyPolicy.approvedBuildDependencies;

const APPROVED_PNPM_OVERRIDES = new Map(
  Object.entries(generatedProjectDependencyPolicy.approvedOverrides),
);
const MAX_PNPM_WORKSPACE_POLICY_BYTES =
  generatedProjectDependencyPolicy.maximumWorkspacePolicyBytes;
const ALLOWED_PNPM_WORKSPACE_KEYS = new Set(
  generatedProjectDependencyPolicy.allowedWorkspaceKeys,
);
const FORBIDDEN_PNPM_WORKSPACE_KEYS = new Set(
  generatedProjectDependencyPolicy.forbiddenWorkspaceKeys,
);

export function findBuildApprovalErrors(workspace, label) {
  if (exceedsPolicySizeLimit(workspace)) {
    return [
      `${label} must not exceed ${MAX_PNPM_WORKSPACE_POLICY_BYTES} UTF-8 bytes.`,
    ];
  }
  const document = parseDocument(workspace, { uniqueKeys: true });
  const errors = document.errors.map(
    (error) => `${label} must be unambiguous YAML: ${error.message}`,
  );
  if (errors.length > 0) {
    return errors;
  }

  let containsUnsafeNode = false;
  visit(document, (_key, node) => {
    if (isAlias(node) || node?.anchor || node?.tag) {
      containsUnsafeNode = true;
      return visit.BREAK;
    }
    return undefined;
  });
  if (containsUnsafeNode) {
    errors.push(
      `${label} must not use YAML anchors, aliases, or explicit tags.`,
    );
  }

  const root = document.contents;
  if (!isMap(root)) {
    return [...errors, `${label} must contain a top-level mapping.`];
  }
  if (root.flow) {
    errors.push(`${label} must use a top-level block mapping.`);
  }
  for (const pair of root.items) {
    const key =
      isScalar(pair.key) && typeof pair.key.value === "string"
        ? pair.key.value
        : undefined;
    if (!key || pair.key.type !== "PLAIN") {
      errors.push(`${label} top-level keys must be canonical plain strings.`);
    }
    if (key && FORBIDDEN_PNPM_WORKSPACE_KEYS.has(key)) {
      errors.push(`${label} must not define ${key}.`);
    } else if (key && !ALLOWED_PNPM_WORKSPACE_KEYS.has(key)) {
      errors.push(`${label} must not define unexpected setting ${key}.`);
    }
  }

  findWorkspacePackageErrors(root, label, errors);
  requirePlainScalar(
    root,
    "ignoreWorkspaceRootCheck",
    true,
    `${label} must enable ignoreWorkspaceRootCheck.`,
    errors,
  );

  requirePlainScalar(
    root,
    "minimumReleaseAge",
    generatedProjectDependencyPolicy.minimumReleaseAgeMinutes,
    `${label} must set minimumReleaseAge to ${generatedProjectDependencyPolicy.minimumReleaseAgeMinutes} minutes.`,
    errors,
  );
  requirePlainScalar(
    root,
    "minimumReleaseAgeIgnoreMissingTime",
    false,
    `${label} must disable minimumReleaseAgeIgnoreMissingTime.`,
    errors,
  );
  requirePlainScalar(
    root,
    "minimumReleaseAgeStrict",
    true,
    `${label} must enable minimumReleaseAgeStrict.`,
    errors,
  );
  requirePlainScalar(
    root,
    "strictDepBuilds",
    true,
    `${label} must enable strictDepBuilds.`,
    errors,
  );
  requirePlainScalar(
    root,
    "blockExoticSubdeps",
    true,
    `${label} must enable blockExoticSubdeps.`,
    errors,
  );

  findOverrideErrors(root, label, errors);

  const allowBuildsPair = root.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === "allowBuilds",
  );
  if (
    !allowBuildsPair ||
    !isScalar(allowBuildsPair.key) ||
    allowBuildsPair.key.type !== "PLAIN"
  ) {
    errors.push(`${label} must define allowBuilds with a canonical plain key.`);
  }
  const allowBuilds = allowBuildsPair?.value;
  if (!isMap(allowBuilds)) {
    return [...errors, `${label} allowBuilds must be a mapping.`];
  }
  if (allowBuilds.flow) {
    errors.push(`${label} allowBuilds must use a block mapping.`);
  }

  const configured = new Set();
  const approved = new Set(APPROVED_BUILD_DEPENDENCIES);
  for (const pair of allowBuilds.items) {
    if (
      !isScalar(pair.key) ||
      typeof pair.key.value !== "string" ||
      pair.key.type !== "PLAIN"
    ) {
      errors.push(`${label} allowBuilds keys must be plain package names.`);
      continue;
    }
    const dependency = pair.key.value;
    configured.add(dependency);
    if (
      !isScalar(pair.value) ||
      pair.value.value !== true ||
      pair.value.type !== "PLAIN"
    ) {
      errors.push(`${label} allowBuilds.${dependency} must be boolean true.`);
    }
    if (!approved.has(dependency)) {
      errors.push(
        `${label} allowBuilds must not approve unexpected package ${dependency}.`,
      );
    }
  }
  for (const dependency of APPROVED_BUILD_DEPENDENCIES) {
    if (!configured.has(dependency)) {
      errors.push(`${label} allowBuilds must approve ${dependency}.`);
    }
  }
  return errors;
}

function findOverrideErrors(root, label, errors) {
  const overridesPair = root.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === "overrides",
  );
  if (!overridesPair) {
    return;
  }
  if (
    !isScalar(overridesPair.key) ||
    overridesPair.key.type !== "PLAIN" ||
    !isMap(overridesPair.value) ||
    overridesPair.value.flow
  ) {
    errors.push(`${label} overrides must use a canonical block mapping.`);
    return;
  }

  const configured = new Map();
  for (const pair of overridesPair.value.items) {
    const selector = isScalar(pair.key) ? pair.key.value : undefined;
    const version = isScalar(pair.value) ? pair.value.value : undefined;
    if (typeof selector !== "string" || typeof version !== "string") {
      errors.push(
        `${label} overrides must map package selectors to version strings.`,
      );
      continue;
    }
    configured.set(selector, version);
    if (APPROVED_PNPM_OVERRIDES.get(selector) !== version) {
      errors.push(
        `${label} overrides must not change unreviewed dependency ${selector}.`,
      );
    }
  }
  for (const [selector, version] of APPROVED_PNPM_OVERRIDES) {
    if (configured.get(selector) !== version) {
      errors.push(`${label} overrides must pin ${selector} to ${version}.`);
    }
  }
}

function findWorkspacePackageErrors(root, label, errors) {
  const packagesPair = root.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === "packages",
  );
  if (
    !packagesPair ||
    !isScalar(packagesPair.key) ||
    packagesPair.key.type !== "PLAIN"
  ) {
    errors.push(`${label} must define packages with a canonical plain key.`);
  }

  const packages = packagesPair?.value;
  if (!isSeq(packages) || packages.items.length === 0) {
    errors.push(`${label} packages must be a non-empty sequence.`);
    return;
  }

  for (const item of packages.items) {
    const pattern = isScalar(item) ? item.value : undefined;
    if (typeof pattern !== "string" || !isSafeWorkspacePattern(pattern)) {
      errors.push(
        `${label} packages must contain only safe in-tree relative paths or globs; found ${JSON.stringify(pattern)}.`,
      );
    }
  }
}

function isSafeWorkspacePattern(value) {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    /[\0-\x1f\x7f]/u.test(value)
  ) {
    return false;
  }

  const pattern = value.startsWith("!") ? value.slice(1) : value;
  if (
    pattern.length === 0 ||
    pattern.startsWith("/") ||
    pattern.startsWith("\\") ||
    pattern.startsWith("~") ||
    pattern.includes("\\") ||
    /^[a-z]:/iu.test(pattern) ||
    /^[a-z][a-z\d+.-]*:/iu.test(pattern) ||
    !/^[a-z\d@._*?/-]+$/iu.test(pattern)
  ) {
    return false;
  }

  return pattern
    .split("/")
    .every((segment) => segment.length > 0 && !segment.includes(".."));
}

function exceedsPolicySizeLimit(content) {
  return (
    content.length > MAX_PNPM_WORKSPACE_POLICY_BYTES ||
    new TextEncoder().encode(content).byteLength >
      MAX_PNPM_WORKSPACE_POLICY_BYTES
  );
}

function requirePlainScalar(root, key, expected, error, errors) {
  const pair = root.items.find(
    (candidate) => isScalar(candidate.key) && candidate.key.value === key,
  );
  if (
    !pair ||
    !isScalar(pair.key) ||
    pair.key.type !== "PLAIN" ||
    !isScalar(pair.value) ||
    pair.value.type !== "PLAIN" ||
    pair.value.value !== expected
  ) {
    errors.push(error);
  }
}
