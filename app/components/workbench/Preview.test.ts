import { describe, expect, it } from 'vitest';
import { idleBuilderPreviewState, type BuilderPreviewSuccess } from '~/agents/builder-preview-types';
import { previewDisplayStatus, previewPresentation } from '~/lib/common/preview-presentation';
import { previewWorkerUrl } from '~/lib/common/preview-url';
import { PREVIEW_SANDBOX } from './Preview';

const success: BuilderPreviewSuccess = {
  id: '12345678-1234-1234-1234-123456789abc',
  url: 'https://12345678-cloudchef-app.account.workers.dev',
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
  it('accepts only HTTPS Workers version preview origins', () => {
    expect(previewWorkerUrl(success.url)).toBe(`${success.url}/`);
    expect(PREVIEW_SANDBOX.split(' ')).toEqual(expect.arrayContaining(['allow-same-origin', 'allow-scripts']));
  });

  it.each([
    'https://workers.dev',
    'https://workers.dev.example.com',
    'https://cloudchef.build',
    'http://12345678-cloudchef-app.account.workers.dev',
    'https://user:password@12345678-cloudchef-app.account.workers.dev',
    'https://12345678-cloudchef-app.account.workers.dev:8443',
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
