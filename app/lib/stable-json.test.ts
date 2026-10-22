import { describe, expect, it } from 'vitest';
import { stableJson } from './stable-json';

describe('stableJson', () => {
  it('writes the same JSON for values whose keys were set in different orders, at any depth', () => {
    expect(stableJson({ b: 1, a: { d: [{ f: 1, e: 2 }], c: null } })).toBe(
      stableJson({ a: { c: null, d: [{ e: 2, f: 1 }] }, b: 1 }),
    );
    expect(stableJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('leaves arrays in order, drops undefined fields as JSON does, and has no JSON for undefined', () => {
    expect(stableJson([3, 1, 2])).toBe('[3,1,2]');
    expect(stableJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
    expect(stableJson(undefined)).toBeUndefined();
  });
});
