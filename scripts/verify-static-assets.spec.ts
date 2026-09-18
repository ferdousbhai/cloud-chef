import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDeployedLicenseArtifactErrors, findStaticAssetExposureErrors } from './verify-static-assets.mjs';

describe('static asset deployment policy', () => {
  it('keeps Worker source maps private and excludes every client source map', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloudchef-assets-'));
    try {
      mkdirSync(join(directory, 'assets'));
      writeFileSync(join(directory, 'assets/app.js.map'), '{}');

      expect(
        findStaticAssetExposureErrors({
          assetDirectory: directory,
          workerConfig: { upload_source_maps: true },
          ignoreContent: 'wrangler.json\n.dev.vars\n*.map\n',
        }),
      ).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('reports deployable maps, disabled private upload, and re-inclusions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloudchef-assets-'));
    try {
      writeFileSync(join(directory, 'app.js.map'), '{}');

      expect(
        findStaticAssetExposureErrors({
          assetDirectory: directory,
          workerConfig: { upload_source_maps: false },
          ignoreContent: '!app.js.map\n',
        }),
      ).toEqual([
        'The built Worker config must keep upload_source_maps enabled for private Worker diagnostics.',
        'The deployed client asset root .assetsignore must contain *.map.',
        'The deployed client asset root .assetsignore must not re-include ignored files.',
        'Client source maps would be deployable: app.js.map.',
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
