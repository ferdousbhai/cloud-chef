import { describe, expect, it } from 'vitest';
import { publicationProgress } from './builder-publication-progress';

describe('publicationProgress', () => {
  it('reports the recorded step, its message and when it was recorded', () => {
    const progress = publicationProgress({
      sequence: 33,
      message: 'Building your app',
      createdAt: 30,
    });

    expect(progress).toEqual({
      message: 'Building your app',
      percent: expect.any(Number),
      updatedAt: 30,
    });
  });

  it('places each recorded step in the ladder', () => {
    const uploading = publicationProgress({
      sequence: 50,
      message: 'Uploading your app',
      createdAt: 5,
    });
    const complete = publicationProgress({ sequence: 80, message: 'Finishing up', createdAt: 6 });

    expect(uploading.percent).toBe(83);
    expect(complete.percent).toBe(100);
  });

  it('omits the position of a step the ladder does not know rather than guessing one', () => {
    const progress = publicationProgress({ sequence: 99, message: 'Something new', createdAt: 1 });

    expect(progress).toEqual({ message: 'Something new', percent: null, updatedAt: 1 });
  });
});
