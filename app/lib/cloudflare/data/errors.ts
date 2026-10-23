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

/** An earlier conversation on a team project, kept to read: it refuses work that would change it. */
export class ChatArchivedError extends Error {
  constructor() {
    super('This conversation continues in a newer one. Open the project to keep working.');
    this.name = 'ChatArchivedError';
  }
}
