import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The generated-application verifier owns the license-artifact implementation; the root inventory
// is the same walk over the same published files, so it reads that library rather than forking it.
import { createLicenseArtifact, readProductionPackages } from '../template/scripts/lib/production-license-artifact.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = resolve(rootDir, 'scripts/production-license-policy.json');
const lockfilePath = resolve(rootDir, 'pnpm-lock.yaml');
const noticeArtifactPath = resolve(rootDir, 'public/THIRD_PARTY_LICENSES.txt');
const nodeModulesPath = resolve(rootDir, 'node_modules');
const NOTICE_ARTIFACT_TITLE = 'Ghostbuild Third-Party Production Dependency Licenses';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function packageIdentity(name, version) {
  return `${name}@${version}`;
}

export function findLicenseNoticeErrors(packages, policy) {
  const errors = [];
  const metadataOnly = new Set(policy?.metadataOnlyPackageAllowlist ?? []);
  const packagesById = new Map(packages.map((entry) => [packageIdentity(entry.name, entry.version), entry]));
  for (const [packageId, entry] of packagesById) {
    if (!entry.hasPackageLicenseEvidence && !metadataOnly.has(packageId)) {
      errors.push(
        `${packageId} publishes no package-level license evidence; review it and add the exact version to metadataOnlyPackageAllowlist if the package metadata is sufficient.`,
      );
    }
  }
  for (const packageId of metadataOnly) {
    const entry = packagesById.get(packageId);
    if (!entry) {
      errors.push(`${packageId} is a stale metadataOnlyPackageAllowlist entry.`);
    } else if (entry.hasPackageLicenseEvidence) {
      errors.push(`${packageId} now publishes license or notice text; remove its metadataOnlyPackageAllowlist entry.`);
    }
  }
  return errors;
}

export function findLicensePolicyErrors(packages, policy) {
  const errors = [];
  if (policy?.schemaVersion !== 1) {
    errors.push('scripts/production-license-policy.json must use schemaVersion 1.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(policy?.reviewedAt ?? '')) {
    errors.push('scripts/production-license-policy.json must record its review date as YYYY-MM-DD.');
  }
  const allowed = new Set(policy?.allowedLicenseExpressions ?? []);
  const missingMetadataOverrides = new Map(Object.entries(policy?.missingLicenseMetadataOverrides ?? {}));
  if (allowed.size === 0) {
    errors.push('The production license allowlist must not be empty.');
  }
  if (packages.length === 0) {
    errors.push('The production dependency inventory must not be empty.');
  }

  const packagesById = new Map();
  for (const entry of packages) {
    const packageId = packageIdentity(entry.name, entry.version);
    if (typeof entry.name !== 'string' || !entry.name || typeof entry.version !== 'string' || !entry.version) {
      errors.push('Every production dependency must have a name and version.');
      continue;
    }
    if (packagesById.has(packageId)) {
      errors.push(`Production dependency inventory contains duplicate ${packageId}.`);
    }
    packagesById.set(packageId, entry);
    if (entry.packageLicense !== entry.license && missingMetadataOverrides.get(packageId) !== entry.license) {
      errors.push(
        `${packageId} license grouping ${JSON.stringify(entry.license)} does not match package metadata ${JSON.stringify(entry.packageLicense)}.`,
      );
    }
    if (!allowed.has(entry.license)) {
      errors.push(`${packageId} declares unreviewed production license ${JSON.stringify(entry.license)}.`);
    }
  }
  for (const [packageId, license] of missingMetadataOverrides) {
    const entry = packagesById.get(packageId);
    if (!entry) {
      errors.push(`${packageId} is a stale missingLicenseMetadataOverrides entry.`);
    } else if (entry.packageLicense !== undefined && entry.packageLicense !== null) {
      errors.push(`${packageId} now publishes license metadata; remove its missingLicenseMetadataOverrides entry.`);
    } else if (entry.license !== license) {
      errors.push(
        `${packageId} missing-license-metadata override ${JSON.stringify(license)} does not match inventory grouping ${JSON.stringify(entry.license)}.`,
      );
    }
  }
  return errors;
}

export function createSpdxDocument(packages, policy, lockfileContent) {
  const normalized = packages.map((entry) => {
    const license = policy.spdxLicenseNormalizations?.[entry.license] ?? entry.license;
    const identity = packageIdentity(entry.name, entry.version);
    return {
      SPDXID: `SPDXRef-Package-${sha256(identity).slice(0, 24)}`,
      name: entry.name,
      versionInfo: entry.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: license,
      licenseDeclared: license,
      copyrightText: 'NOASSERTION',
    };
  });
  const inventoryIdentity = JSON.stringify(
    normalized.map(({ name, versionInfo, licenseDeclared }) => [name, versionInfo, licenseDeclared]),
  );
  const namespaceDigest = sha256(`${sha256(lockfileContent)}\n${inventoryIdentity}`);
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'ghostbuild-production-dependencies',
    documentNamespace: `https://ghostbuild.dev/.well-known/sbom/production/${namespaceDigest}`,
    creationInfo: {
      // A fixed timestamp keeps lockfile-identical inventories byte-for-byte reproducible.
      created: '1970-01-01T00:00:00Z',
      creators: ['Tool: ghostbuild-production-license-inventory'],
    },
    packages: normalized,
    relationships: normalized.map((entry) => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: entry.SPDXID,
    })),
  };
}

function readProductionLicenseInventory() {
  const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`pnpm production license inventory failed${detail ? `: ${detail}` : '.'}`);
  }
  return JSON.parse(result.stdout);
}

export function verifyProductionLicenses() {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const report = readProductionLicenseInventory();
  const noticePackages = readProductionPackages(report, nodeModulesPath);
  const packages = noticePackages.map(({ name, version, license, packageLicense }) => ({
    name,
    version,
    license,
    packageLicense,
  }));
  const lockfileContent = readFileSync(lockfilePath, 'utf8');
  const expectedNoticeArtifact = createLicenseArtifact(noticePackages, policy, lockfileContent, NOTICE_ARTIFACT_TITLE);
  const errors = [...findLicensePolicyErrors(packages, policy), ...findLicenseNoticeErrors(noticePackages, policy)];
  if (!existsSync(noticeArtifactPath)) {
    errors.push('public/THIRD_PARTY_LICENSES.txt is missing; run pnpm run licenses:generate.');
  } else if (readFileSync(noticeArtifactPath, 'utf8') !== expectedNoticeArtifact) {
    errors.push('public/THIRD_PARTY_LICENSES.txt is stale; run pnpm run licenses:generate.');
  }
  return {
    errors,
    packages,
    policy,
    lockfileContent,
    expectedNoticeArtifact,
    noticePackageCount: noticePackages.length,
  };
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && !['--spdx', '--write-notices'].includes(args[0]))) {
      throw new Error('Usage: node scripts/verify-production-licenses.mjs [--spdx|--write-notices]');
    }
    const result = verifyProductionLicenses();
    const substantiveErrors = result.errors.filter((error) => !error.startsWith('public/THIRD_PARTY_LICENSES.txt is '));
    if (args[0] === '--write-notices' && substantiveErrors.length === 0) {
      writeFileSync(noticeArtifactPath, result.expectedNoticeArtifact);
      console.log(`Wrote public/THIRD_PARTY_LICENSES.txt for ${result.noticePackageCount} production packages.`);
    } else if (result.errors.length > 0) {
      console.error(result.errors.map((error) => `- ${error}`).join('\n'));
      process.exitCode = 1;
    } else if (args[0] === '--spdx') {
      console.log(JSON.stringify(createSpdxDocument(result.packages, result.policy, result.lockfileContent), null, 2));
    } else {
      console.log(
        `Reviewed production dependency licenses: ${result.packages.length} packages; policy reviewed ${result.policy.reviewedAt}.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
