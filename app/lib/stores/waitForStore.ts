type ReadableStore<T> = {
  get(): T;
  listen(listener: (value: T) => void): () => void;
};

interface WaitForStoreOptions {
  signal?: AbortSignal;
}

export async function waitForStoreValue<T, TResult>(
  store: ReadableStore<T>,
  selectValue: (value: T) => TResult | null | undefined,
  options: WaitForStoreOptions = {},
): Promise<TResult> {
  options.signal?.throwIfAborted();
  const value = selectValue(store.get());
  if (value !== null && value !== undefined) {
    return value;
  }

  return new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined = undefined;

    const cleanup = () => {
      unlisten?.();
      options.signal?.removeEventListener('abort', handleAbort);
    };
    const handleAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(options.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };

    options.signal?.addEventListener('abort', handleAbort, { once: true });
    unlisten = store.listen((storeValue) => {
      if (settled) {
        return;
      }
      try {
        const value = selectValue(storeValue);
        if (value !== null && value !== undefined) {
          settled = true;
          cleanup();
          resolve(value);
        }
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    });

    // Nanostores listeners fire synchronously. If the selected value changed
    // between get() and listen(), the callback can settle before `unlisten` is
    // assigned, so clean up once more after registration.
    if (settled) {
      cleanup();
    }
  });
}
