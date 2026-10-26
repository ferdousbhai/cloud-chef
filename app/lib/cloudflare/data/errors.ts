export class DataNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataNotFoundError';
  }
}

/** A project this person may not use the way they asked (no access, or view only). */
export class ProjectForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectForbiddenError';
  }
}

export class SubchatLimitError extends Error {
  constructor() {
    super('This project has reached the maximum number of subchats.');
    this.name = 'SubchatLimitError';
  }
}

/**
 * A project's repository that could not do what was asked, for a reason the person can act on (400 for an
 * upload it can't read, 409, 413, 503).
 */
export class ProjectRepositoryFailureError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 413 | 503,
  ) {
    super(message);
    this.name = 'ProjectRepositoryFailureError';
  }
}
