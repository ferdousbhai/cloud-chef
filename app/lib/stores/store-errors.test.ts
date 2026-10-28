import { atom } from 'nanostores';
import { describe, expect, it } from 'vitest';

/**
 * A listener that throws once must not silence every store after it: nanostores 0.11 left its listener queue full
 * after a throw, so no later change reached React and the composer snapped back to stale text on every keystroke.
 */
describe('stores after a listener throws', () => {
  it('keep telling their other listeners about later changes', () => {
    const failing = atom(0);
    const other = atom('');
    const seen: string[] = [];
    failing.listen(() => {
      throw new Error('A listener failed.');
    });
    other.listen((value) => seen.push(value));

    expect(() => failing.set(1)).toThrow('A listener failed.');
    other.set('typed');

    expect(seen).toEqual(['typed']);
  });
});
