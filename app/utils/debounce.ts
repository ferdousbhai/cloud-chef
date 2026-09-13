type Debounced<Args extends unknown[]> = ((...args: Args) => void) & {
  cancel: () => void;
  flush: () => void;
};

export function debounce<Args extends unknown[]>(func: (...args: Args) => void, wait: number): Debounced<Args> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let pendingArgs: Args | undefined;

  const invoke = () => {
    const args = pendingArgs;
    pendingArgs = undefined;
    timeout = undefined;
    if (args) {
      func(...args);
    }
  };

  const debounced = function executedFunction(...args: Args) {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    pendingArgs = args;
    timeout = setTimeout(invoke, wait);
  };

  debounced.cancel = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    pendingArgs = undefined;
  };

  debounced.flush = () => {
    if (timeout === undefined) {
      return;
    }
    clearTimeout(timeout);
    invoke();
  };

  return debounced;
}
