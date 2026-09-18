import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const licenseFilePattern = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const readmeFilePattern = /^readme(?:[._-].*)?$/i;
const licenseTextMarker =
  /(?:Permission is hereby granted|Apache License|ISC License|Mozilla Public License|Redistribution and use in source and binary forms|Creative Commons Attribution|Python Software Foundation License|The Unlicense|Blue Oak Model License)/i;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packageIdentity(name, version) {
  return `${name}@${version}`;
}

function metadataValue(value) {
  if (value === undefined || value === null || value === "") {
    return "<not published>";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function packagePathWithin(nodeModulesPath, reportedPath) {
  const packagePath = resolve(reportedPath);
  const relativePath = relative(nodeModulesPath, packagePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(nodeModulesPath, relativePath) !== packagePath
  ) {
    throw new Error(
      `Production license inventory returned a path outside node_modules: ${reportedPath}.`,
    );
  }
  return packagePath;
}

export function isPlatformNeutralProductionPackage(metadata) {
  return ![metadata?.os, metadata?.cpu, metadata?.libc].some(
    (value) =>
      (Array.isArray(value) && value.length > 0) ||
      (typeof value === "string" && value.length > 0),
  );
}

function walkFiles(directory, packageRoot, matches, mode, depth = 0) {
  if (depth > 12) {
    throw new Error(
      `Production package notice traversal exceeded its depth limit in ${relative(packageRoot, directory)}.`,
    );
  }
  const entries = readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(path, packageRoot, matches, mode, depth + 1);
    } else if (
      entry.isFile() &&
      ((mode === "license" && licenseFilePattern.test(entry.name)) ||
        (mode === "readme" && readmeFilePattern.test(entry.name)))
    ) {
      if (
        mode === "license" ||
        licenseTextMarker.test(readFileSync(path, "utf8"))
      ) {
        matches.push(path);
      }
    }
  }
}

function exactText(path, packageId) {
  const bytes = readFileSync(path);
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    throw new Error(
      `${packageId} publishes a non-UTF-8 license or notice file at ${path}.`,
    );
  }
  return content;
}

function packageLicenseFiles(packagePath, packageId) {
  const licenseMatches = [];
  walkFiles(packagePath, packagePath, licenseMatches, "license");
  const hasTopLevelLicense = licenseMatches.some(
    (path) => !relative(packagePath, path).includes(sep),
  );
  const readmeMatches = [];
  if (!hasTopLevelLicense) {
    walkFiles(packagePath, packagePath, readmeMatches, "readme");
  }
  const hasTopLevelReadmeLicense = readmeMatches.some(
    (path) => !relative(packagePath, path).includes(sep),
  );
  const files = [...new Set([...licenseMatches, ...readmeMatches])]
    .sort((left, right) =>
      relative(packagePath, left).localeCompare(relative(packagePath, right)),
    )
    .map((path) => ({
      path: relative(packagePath, path).split(sep).join("/"),
      content: exactText(path, packageId),
    }));
  return {
    files,
    hasPackageLicenseEvidence: hasTopLevelLicense || hasTopLevelReadmeLicense,
  };
}

export function readProductionPackages(report, nodeModulesPath) {
  const packages = [];
  for (const [reportedLicense, entries] of Object.entries(report ?? {})) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (
        !Array.isArray(entry?.versions) ||
        !Array.isArray(entry?.paths) ||
        entry.versions.length !== entry.paths.length
      ) {
        throw new Error(
          `pnpm returned mismatched versions and package paths for ${entry?.name ?? "<unknown>"}.`,
        );
      }
      for (let index = 0; index < entry.versions.length; index += 1) {
        const version = entry.versions[index];
        const packagePath = packagePathWithin(
          nodeModulesPath,
          entry.paths[index],
        );
        const metadata = JSON.parse(
          readFileSync(join(packagePath, "package.json"), "utf8"),
        );
        const packageId = packageIdentity(entry.name, version);
        if (metadata.name !== entry.name || metadata.version !== version) {
          throw new Error(
            `${packageId} does not match the installed package metadata.`,
          );
        }
        // Host-restricted native packages implement the local build toolchain;
        // they are not present in the deployed Worker or browser asset set.
        // Excluding them keeps this distributed artifact platform-neutral.
        if (!isPlatformNeutralProductionPackage(metadata)) {
          continue;
        }
        const licenseEvidence = packageLicenseFiles(packagePath, packageId);
        packages.push({
          name: entry.name,
          version,
          license: reportedLicense,
          packageLicense: metadata.license,
          author: metadata.author,
          repository: metadata.repository,
          homepage: metadata.homepage,
          licenseFiles: licenseEvidence.files,
          hasPackageLicenseEvidence: licenseEvidence.hasPackageLicenseEvidence,
        });
      }
    }
  }
  return packages.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version),
  );
}

export function findProductionLicenseErrors(packages, policy) {
  const errors = [];
  const allowedLicenses = new Set(policy?.allowedLicenseExpressions ?? []);
  const metadataOnly = new Set(policy?.metadataOnlyPackageAllowlist ?? []);
  const packageIds = new Set();
  if (policy?.schemaVersion !== 1) {
    errors.push("The production license policy must use schemaVersion 1.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(policy?.reviewedAt ?? "")) {
    errors.push(
      "The production license policy must record reviewedAt as YYYY-MM-DD.",
    );
  }
  if (packages.length === 0 || allowedLicenses.size === 0) {
    errors.push(
      "The production dependency and license inventories must not be empty.",
    );
  }
  for (const entry of packages) {
    const packageId = packageIdentity(entry.name, entry.version);
    if (packageIds.has(packageId)) {
      errors.push(
        `Production dependency inventory contains duplicate ${packageId}.`,
      );
    }
    packageIds.add(packageId);
    if (entry.packageLicense !== entry.license) {
      errors.push(
        `${packageId} license grouping does not match its package metadata.`,
      );
    }
    if (!allowedLicenses.has(entry.license)) {
      errors.push(
        `${packageId} declares unreviewed production license ${JSON.stringify(entry.license)}.`,
      );
    }
    if (!entry.hasPackageLicenseEvidence && !metadataOnly.has(packageId)) {
      errors.push(
        `${packageId} publishes no package-level license evidence and requires exact-version review.`,
      );
    }
  }
  for (const packageId of metadataOnly) {
    const entry = packages.find(
      (candidate) =>
        packageIdentity(candidate.name, candidate.version) === packageId,
    );
    if (!entry) {
      errors.push(`${packageId} is a stale metadata-only review entry.`);
    } else if (entry.hasPackageLicenseEvidence) {
      errors.push(
        `${packageId} now publishes license text; remove its metadata-only review entry.`,
      );
    }
  }
  return errors;
}

export function createLicenseArtifact(
  packages,
  policy,
  lockfileContent,
  title = "CloudChef Generated Application Third-Party Licenses",
) {
  const texts = new Map();
  const records = packages.map((entry) => {
    const files = entry.licenseFiles.map((file) => {
      const digest = sha256(file.content);
      const existing = texts.get(digest);
      const use = `${packageIdentity(entry.name, entry.version)}:${file.path}`;
      if (existing && existing.content !== file.content) {
        throw new Error("SHA-256 collision in production license inventory.");
      } else if (existing) {
        existing.uses.push(use);
      } else {
        texts.set(digest, { content: file.content, uses: [use] });
      }
      return { path: file.path, digest };
    });
    return {
      ...entry,
      author: metadataValue(entry.author),
      repository: metadataValue(entry.repository),
      homepage: metadataValue(entry.homepage),
      files,
    };
  });
  const inventoryDigest = sha256(
    `${sha256(lockfileContent)}\n${JSON.stringify(
      records.map(({ name, version, license, files }) => [
        name,
        version,
        license,
        files.map(({ path, digest }) => [path, digest]),
      ]),
    )}`,
  );
  const lines = [
    title,
    "",
    "This generated artifact inventories every exact platform-neutral production package version.",
    "Published package license and notice files are reproduced verbatim and deduplicated by SHA-256.",
    "Host-restricted native build-tool binaries are excluded because they are not distributed in the Worker or client artifact.",
    "A package whose package-level evidence is <not published> remains exact-version allowlisted for legal review; nested component notices are still reproduced.",
    "This automated artifact supports diligence but does not replace legal review.",
    "",
    `Policy reviewed: ${policy.reviewedAt}`,
    `Production packages: ${records.length}`,
    `Inventory SHA-256: ${inventoryDigest}`,
    "",
    "PACKAGE INVENTORY",
    "=================",
  ];
  for (const entry of records) {
    lines.push(
      "",
      packageIdentity(entry.name, entry.version),
      `Declared license: ${entry.license}`,
      `Author: ${entry.author}`,
      `Repository: ${entry.repository}`,
      `Homepage: ${entry.homepage}`,
      `Package-level license evidence: ${entry.hasPackageLicenseEvidence ? "published" : "<not published>"}`,
    );
    if (entry.files.length === 0) {
      lines.push("Published license/notice files: <not published>");
    } else {
      lines.push("Published license/notice files:");
      for (const file of entry.files) {
        lines.push(`- ${file.path} (SHA-256 ${file.digest})`);
      }
    }
  }
  lines.push(
    "",
    "VERBATIM LICENSE AND NOTICE TEXTS",
    "=================================",
    "",
  );
  for (const [digest, entry] of [...texts.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`SHA-256 ${digest}`, "Used by:");
    for (const use of entry.uses.sort()) {
      lines.push(`- ${use}`);
    }
    lines.push("----- BEGIN VERBATIM CONTENT -----");
    lines.push(entry.content);
    lines.push("----- END VERBATIM CONTENT -----", "");
  }
  return `${lines.join("\n")}\n`;
}
