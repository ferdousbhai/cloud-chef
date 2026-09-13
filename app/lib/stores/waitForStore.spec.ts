import { atom } from 'nanostores';
import { describe, expect, it, vi } from 'vitest';
import { waitForStoreValue } from './waitForStore';

describe('waitForStore', () => {
  it('waits for a selected value', async () => {
    const store = atom<number | null>(null);
    const promise = waitForStoreValue(store, (value) => value);

    store.set(3);

    await expect(promise).resolves.toBe(3);
  });

  it('unsubscribes when the wait is aborted', async () => {
    const unlisten = vi.fn();
    const listen = vi.fn(() => unlisten);
    const store = { get: () => 'waiting', listen };
    const controller = new AbortController();
    const promise = waitForStoreValue(store, (value) => (value === 'ready' ? value : null), {
      signal: controller.signal,
    });

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(listen).toHaveBeenCalledOnce();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('unsubscribes when a value becomes ready during listener registration', async () => {
    const unlisten = vi.fn();
    const store = {
      get: () => 'waiting',
      listen: (listener: (value: string) => void) => {
        listener('ready');
        return unlisten;
      },
    };

    await expect(waitForStoreValue(store, (value) => (value === 'ready' ? value : null))).resolves.toBe('ready');
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
