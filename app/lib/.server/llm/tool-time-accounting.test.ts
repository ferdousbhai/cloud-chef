import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolTimeAccounting } from './tool-time-accounting';

afterEach(() => {
  vi.useRealTimers();
});

/** Runs `step` with the clock at `time`. */
function at(time: number, step: () => void) {
  vi.setSystemTime(time);
  step();
}

describe('tool time accounting', () => {
  it('counts a concurrent batch once, not once per tool', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // The whole point of the split: three parallel reads that each take a second cost the turn
    // one second. Summing them would report tool time larger than the turn itself.
    const accounting = createToolTimeAccounting();
    at(0, () => {
      accounting.start('a', 'read');
      accounting.start('b', 'read');
      accounting.start('c', 'read');
    });
    at(1_000, () => {
      accounting.end('a');
      accounting.end('b');
      accounting.end('c');
    });

    expect(accounting.wallClockMs()).toBe(1_000);
    expect(accounting.byName()).toEqual({ read: 3_000 });
  });

  it('excludes the gaps between tool batches, which is the model time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const accounting = createToolTimeAccounting();
    at(0, () => accounting.start('a', 'exec'));
    at(100, () => accounting.end('a'));
    at(5_000, () => accounting.start('b', 'write'));
    at(5_400, () => accounting.end('b'));

    expect(accounting.wallClockMs()).toBe(500);
    expect(accounting.byName()).toEqual({ exec: 100, write: 400 });
  });
});
