import { describe, expect, it } from 'vitest';
import {
  failedBuilderPreviewState,
  idleBuilderPreviewState,
  isPreviewStale,
  previewStateForWorkspace,
  type BuilderPreviewSuccess,
} from './builder-preview-types';

const successful: BuilderPreviewSuccess = {
  id: 'preview-a',
  url: 'https://cloudchef-app-preview.account.workers.dev',
  workspaceRevision: 4,
  snapshotRevision: 'snapshot-sha',
  readyAt: '2026-07-30T10:00:00.000Z',
};

describe('Builder preview state', () => {
  it('marks the last preview stale as soon as the durable workspace advances', () => {
    const ready = {
      ...idleBuilderPreviewState(),
      status: 'ready' as const,
      workspaceRevision: 4,
      published: successful,
    };

    expect(previewStateForWorkspace(ready, 5)).toMatchObject({
      status: 'ready',
      stale: true,
      published: successful,
    });
  });

  it('keeps the published preview visible when a replacement publication fails', () => {
    const replacement = {
      ...idleBuilderPreviewState(),
      status: 'building' as const,
      pendingId: 'preview-b',
      workspaceRevision: 5,
      published: successful,
    };

    expect(failedBuilderPreviewState(replacement, 5, 'Publication failed')).toMatchObject({
      status: 'failed',
      pendingId: null,
      published: successful,
      stale: true,
      error: 'Publication failed',
    });
  });

  it('uses the exact validated workspace revision to determine staleness', () => {
    expect(isPreviewStale(successful, 4)).toBe(false);
    expect(isPreviewStale(successful, 5)).toBe(true);
  });
});
