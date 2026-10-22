const MAX_STABLE_READ_ATTEMPTS = 3;

class StableWorkspaceReadConflictError extends Error {
  readonly code = 'workspace_read_conflict';

  constructor() {
    super('The project changed while it was being read. Retry the read.');
    this.name = 'StableWorkspaceReadConflictError';
  }
}

/** Labels an async read only with a revision observed unchanged on both sides of that read. */
export async function stableWorkspaceRead<T>(
  revision: () => number,
  read: () => Promise<T>,
): Promise<{ value: T; revision: number }> {
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const before = revision();
    const value = await read();
    const after = revision();
    if (before === after) {
      return { value, revision: after };
    }
  }
  throw new StableWorkspaceReadConflictError();
}
