import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDeployedLicenseArtifactErrors, findStaticAssetExposureErrors } from './verify-static-assets.mjs';

describe('static asset deployment policy', () => {
  it('keeps Worker source maps private and ships no client source map', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloudchef-build-output-'));
    try {
      mkdirSync(join(directory, 'assets/assets'), { recursive: true });
      mkdirSync(join(directory, 'bundle/assets'), { recursive: true });
      writeFileSync(join(directory, 'assets/assets/app.js'), '');
      writeFileSync(join(directory, 'bundle/index.js.map'), '{}');
      writeFileSync(join(directory, 'bundle/assets/chunk.js.map'), '{}');

      expect(
        findStaticAssetExposureErrors({
          assetDirectory: join(directory, 'assets'),
          bundleDirectory: join(directory, 'bundle'),
        }),
      ).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('reports public maps, local environment files, and a missing Worker source map', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloudchef-build-output-'));
    try {
      mkdirSync(join(directory, 'assets'));
      mkdirSync(join(directory, 'bundle'));
      writeFileSync(join(directory, 'assets/app.js.map'), '{}');
      writeFileSync(join(directory, 'bundle/.dev.vars'), 'SECRET=1');

      expect(
        findStaticAssetExposureErrors({
          assetDirectory: join(directory, 'assets'),
          bundleDirectory: join(directory, 'bundle'),
        }),
      ).toEqual([
        'The built Worker bundle must include index.js.map so cf deploy uploads it as a private source map.',
        'Client source maps would be deployed as public assets: app.js.map.',
        'Local environment files would be deployed: bundle/.dev.vars.',
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('requires the exact generated license artifact in the deployed client', () => {
    expect(findDeployedLicenseArtifactErrors({ sourceContent: 'licenses\n', deployedContent: 'licenses\n' })).toEqual(
      [],
    );
    expect(findDeployedLicenseArtifactErrors({ sourceContent: 'licenses\n', deployedContent: null })).toEqual([
      'The built client must include THIRD_PARTY_LICENSES.txt.',
    ]);
    expect(findDeployedLicenseArtifactErrors({ sourceContent: 'licenses\n', deployedContent: 'stale\n' })).toEqual([
      'The built client THIRD_PARTY_LICENSES.txt must exactly match the generated public artifact.',
    ]);
  });
});
