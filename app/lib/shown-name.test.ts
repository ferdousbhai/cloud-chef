import { describe, expect, it } from 'vitest';
import { shownName } from './shown-name';

describe('shownName', () => {
  it('shows a name as stored, and never an email address', () => {
    expect(shownName('Sara Ahmed')).toBe('Sara Ahmed');
    expect(shownName('sara.a')).toBe('sara.a');
    expect(shownName('Sara.Ahmed@Example.com')).toBe('Sara.Ahmed');
    expect(shownName('  ')).toBe('Someone');
    expect(shownName('@example.com')).toBe('Someone');
  });
});
