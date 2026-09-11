import { describe, expect, it } from 'vitest';
import { createSpdxDocument, findLicenseNoticeErrors, findLicensePolicyErrors } from './verify-production-licenses.mjs';

const policy = {
  schemaVersion: 1,
  reviewedAt: '2026-07-20',
  allowedLicenseExpressions: ['Apache-2.0', 'MIT/X11'],
  spdxLicenseNormalizations: { 'MIT/X11': 'MIT' },
  metadataOnlyPackageAllowlist: ['metadata-only@1.0.0'],
};

describe('production dependency license inventory', () => {
  it('fails closed for unreviewed, inconsistent, and duplicate licenses', () => {
    expect(
      findLicensePolicyErrors(
        [
          { name: 'unsafe', version: '1.0.0', license: 'AGPL-3.0-only', packageLicense: 'AGPL-3.0-only' },
          { name: 'unsafe', version: '1.0.0', license: 'MIT', packageLicense: 'UNKNOWN' },
        ],
        policy,
      ),
    ).toEqual([
      'unsafe@1.0.0 declares unreviewed production license "AGPL-3.0-only".',
      'Production dependency inventory contains duplicate unsafe@1.0.0.',
      'unsafe@1.0.0 license grouping "MIT" does not match package metadata "UNKNOWN".',
      'unsafe@1.0.0 declares unreviewed production license "MIT".',
    ]);
  });

  it('accepts an exact reviewed grouping when package metadata omits its license', () => {
    const reviewedPolicy = {
      ...policy,
      allowedLicenseExpressions: [...policy.allowedLicenseExpressions, 'MIT'],
      missingLicenseMetadataOverrides: { '@journeyapps/wa-sqlite@1.7.2': 'MIT' },
    };
    expect(
      findLicensePolicyErrors(
        [
          {
            name: '@journeyapps/wa-sqlite',
            version: '1.7.2',
            license: 'MIT',
            packageLicense: undefined,
          },
        ],
        reviewedPolicy,
      ),
    ).toEqual([]);
  });

  it('creates a deterministic SPDX 2.3 document with normalized license identifiers', () => {
    const packages = [
      { name: 'buffer-builder', version: '0.2.0', license: 'MIT/X11', packageLicense: 'MIT/X11' },
      { name: 'example', version: '1.0.0', license: 'Apache-2.0', packageLicense: 'Apache-2.0' },
    ];
    const first = createSpdxDocument(packages, policy, 'lockfile');
    const second = createSpdxDocument(packages, policy, 'lockfile');

    expect(first).toEqual(second);
    expect(first).toMatchObject({ spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0' });
    expect(first.packages[0]).toMatchObject({ licenseDeclared: 'MIT', filesAnalyzed: false });
    expect(JSON.stringify(first)).not.toContain('/private/install');
  });

  it('requires exact review for packages that publish no license file', () => {
    const packages = [
      { name: 'metadata-only', version: '1.0.0', hasPackageLicenseEvidence: false, licenseFiles: [] },
      { name: 'unreviewed', version: '2.0.0', hasPackageLicenseEvidence: false, licenseFiles: [] },
      {
        name: 'nested-only',
        version: '1.0.0',
        hasPackageLicenseEvidence: false,
        licenseFiles: [{ path: 'vendor/component/LICENSE', content: 'vendored notice' }],
      },
      {
        name: 'now-complete',
        version: '3.0.0',
        hasPackageLicenseEvidence: true,
        licenseFiles: [{ path: 'LICENSE', content: 'text' }],
      },
    ];
    expect(
      findLicenseNoticeErrors(packages, {
        metadataOnlyPackageAllowlist: ['metadata-only@1.0.0', 'now-complete@3.0.0', 'removed@1.0.0'],
      }),
    ).toEqual([
      'unreviewed@2.0.0 publishes no package-level license evidence; review it and add the exact version to metadataOnlyPackageAllowlist if the package metadata is sufficient.',
      'nested-only@1.0.0 publishes no package-level license evidence; review it and add the exact version to metadataOnlyPackageAllowlist if the package metadata is sufficient.',
      'now-complete@3.0.0 now publishes license or notice text; remove its metadataOnlyPackageAllowlist entry.',
      'removed@1.0.0 is a stale metadataOnlyPackageAllowlist entry.',
    ]);
  });
});
