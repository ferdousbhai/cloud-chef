import { describe, expect, it } from 'vitest';
import { publicationProgress } from './builder-publication-progress';

describe('publicationProgress', () => {
  it('reports the recorded step, its message and when it was recorded', () => {
    const progress = publicationProgress('preview', {
      sequence: 33,
      message: 'Building production app',
      createdAt: 30,
    });

    expect(progress).toEqual({
      lane: 'preview',
      message: 'Building production app',
      percent: expect.any(Number),
      updatedAt: 30,
    });
  });

  it('places each recorded step in its own lane ladder', () => {
    const uploading = publicationProgress('deployment', {
      sequence: 50,
      message: 'Uploading assets and publishing Worker',
      createdAt: 5,
    });
    const complete = publicationProgress('deployment', { sequence: 80, message: 'Deployment complete', createdAt: 6 });

    expect(uploading.percent).toBe(83);
    expect(complete.percent).toBe(100);
  });

  it('omits the position of a step the ladder does not know rather than guessing one', () => {
    const progress = publicationProgress('preview', { sequence: 99, message: 'Something new', createdAt: 1 });

    expect(progress).toEqual({ lane: 'preview', message: 'Something new', percent: null, updatedAt: 1 });
  });
});
