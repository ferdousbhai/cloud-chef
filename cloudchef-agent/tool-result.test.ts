import { describe, expect, it } from 'vitest';
import { toolFailure, toolResultSucceeded } from './tool-result.js';

describe('toolResultSucceeded', () => {
  it('does not infer failure from legacy Error-prefixed strings', () => {
    expect(toolResultSucceeded('Error: plain model-visible text')).toBe(true);
    expect(toolResultSucceeded(toolFailure('Structured failure'))).toBe(false);
  });
});
