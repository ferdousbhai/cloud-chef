import { describe, expect, it } from 'vitest';
import { idleBuilderPreviewState, type BuilderPreviewSuccess } from '~/agents/builder-preview-types';
import { previewDisplayStatus, previewPresentation } from '~/lib/common/preview-presentation';
import { previewWorkerUrl } from '~/lib/common/preview-url';
import { PREVIEW_SANDBOX } from './Preview';

const success: BuilderPreviewSuccess = {
  id: '12345678-1234-1234-1234-123456789abc',
  url: 'https://d6738251-cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417-preview.account.workers.dev',
  workspaceRevision: 1,
  snapshotRevision: 'snapshot-1',
  readyAt: '2026-08-06T19:00:00.000Z',
};

describe('previewDisplayStatus', () => {
  it('fails closed when a completed preview has an untrusted URL', () => {
    expect(previewDisplayStatus('ready', success, false)).toBe('failed');
  });
});

describe('previewFrameUrl', () => {
  it('accepts only the HTTPS origin of a project’s preview Worker', () => {
    expect(previewWorkerUrl(success.url)).toBe(`${success.url}/`);
    expect(PREVIEW_SANDBOX.split(' ')).toEqual(expect.arrayContaining(['allow-same-origin', 'allow-scripts']));
  });

  it.each([
    'https://workers.dev',
    'https://workers.dev.example.com',
    'https://cloudchef.build',
    'http://d6738251-cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417-preview.account.workers.dev',
    'https://user:password@d6738251-cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417-preview.account.workers.dev',
    'https://d6738251-cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417-preview.account.workers.dev:8443',
    // Production's address, and a version preview URL that would serve an earlier version on its data.
    'https://cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417.account.workers.dev',
    'https://d6738251-cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417.account.workers.dev',
    // A preview Worker name whose leading digits are not its identity's, and the earlier unframeable name.
    'https://12345678-cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417-preview.account.workers.dev',
    'https://cloudchef-d6738251-57e1-4d83-9589-1b6c6d982417-preview.account.workers.dev',
    '/relative-preview',
    'not a url',
  ])('rejects an untrusted preview URL: %s', (url) => {
    expect(previewWorkerUrl(url)).toBeNull();
  });
});

describe('previewPresentation', () => {
  it('offers Update for a stale immutable preview', () => {
    const presentation = previewPresentation({
      ...idleBuilderPreviewState(),
      status: 'ready',
      stale: true,
      published: success,
    });

    expect(presentation.canUpdate).toBe(true);
    expect(presentation.canReload).toBe(true);
  });

  it('disables reload for an invalid provider URL', () => {
    const invalid = { ...success, url: 'https://example.com' };
    const presentation = previewPresentation({
      ...idleBuilderPreviewState(),
      status: 'ready',
      published: invalid,
    });

    expect(presentation.canReload).toBe(false);
    expect(presentation.previewUrl).toBeNull();
    expect(presentation.status).toBe('failed');
  });
});
