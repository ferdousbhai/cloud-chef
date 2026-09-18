import { describe, expect, it } from 'vitest';
import {
  createLicenseArtifact,
  findProductionLicenseErrors,
  isPlatformNeutralProductionPackage,
} from '../template/scripts/lib/production-license-artifact.mjs';

const policy = {
  schemaVersion: 1,
  reviewedAt: '2026-07-20',
  allowedLicenseExpressions: ['MIT'],
  metadataOnlyPackageAllowlist: ['metadata-only@1.0.0'],
};

describe('generated-app production license artifact', () => {
  it('uses the same portable dependency set across macOS and Linux builders', () => {
    expect(isPlatformNeutralProductionPackage({ name: 'portable' })).toBe(true);
    expect(isPlatformNeutralProductionPackage({ os: ['darwin'], cpu: ['arm64'] })).toBe(false);
    expect(isPlatformNeutralProductionPackage({ os: ['linux'], cpu: ['x64'] })).toBe(false);
    expect(isPlatformNeutralProductionPackage({ libc: ['musl'] })).toBe(false);
  });

  it('is exact-version, deterministic, and deduplicates verbatim texts', () => {
    const packages = [
      {
        name: 'a-package',
        version: '1.0.0',
        license: 'MIT',
        packageLicense: 'MIT',
        author: 'Author A',
        repository: 'https://example.test/a',
        homepage: undefined,
        hasPackageLicenseEvidence: true,
        licenseFiles: [{ path: 'LICENSE', content: 'verbatim\n' }],
      },
      {
        name: 'b-package',
        version: '2.0.0',
        license: 'MIT',
        packageLicense: 'MIT',
        author: undefined,
        repository: undefined,
        homepage: undefined,
        hasPackageLicenseEvidence: true,
        licenseFiles: [{ path: 'NOTICE', content: 'verbatim\n' }],
      },
    ];

    const first = createLicenseArtifact(packages, policy, 'lockfile');
    expect(first).toBe(createLicenseArtifact(packages, policy, 'lockfile'));
    expect(first).toContain('a-package@1.0.0');
    expect(first).toContain('b-package@2.0.0');
    expect(first.match(/----- BEGIN VERBATIM CONTENT -----/g)).toHaveLength(1);
    // An inventory must never leak the build host's absolute install paths.
    expect(first).not.toContain('/private/install');
    // The root verifier shares this builder and only supplies its own heading.
    expect(first.split('\n')[0]).toBe('CloudChef Generated Application Third-Party Licenses');
    expect(createLicenseArtifact(packages, policy, 'lockfile', 'Other Title').split('\n')[0]).toBe('Other Title');
  });

  it('fails closed for unreviewed licenses and metadata-only packages', () => {
    expect(
      findProductionLicenseErrors(
        [
          {
            name: 'unreviewed',
            version: '1.0.0',
            license: 'AGPL-3.0-only',
            packageLicense: 'AGPL-3.0-only',
            hasPackageLicenseEvidence: false,
            licenseFiles: [],
          },
        ],
        policy,
      ),
    ).toEqual([
      'unreviewed@1.0.0 declares unreviewed production license "AGPL-3.0-only".',
      'unreviewed@1.0.0 publishes no package-level license evidence and requires exact-version review.',
      'metadata-only@1.0.0 is a stale metadata-only review entry.',
    ]);
  });

  it('does not treat a nested component LICENSE as package-level evidence', () => {
    expect(
      findProductionLicenseErrors(
        [
          {
            name: 'nested-only',
            version: '1.0.0',
            license: 'MIT',
            packageLicense: 'MIT',
            hasPackageLicenseEvidence: false,
            licenseFiles: [{ path: 'vendor/component/LICENSE', content: 'component notice' }],
          },
        ],
        { ...policy, metadataOnlyPackageAllowlist: [] },
      ),
    ).toEqual(['nested-only@1.0.0 publishes no package-level license evidence and requires exact-version review.']);
  });
});
