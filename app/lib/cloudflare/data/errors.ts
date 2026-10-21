export class DataNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataNotFoundError';
  }
}

export class SubchatLimitError extends Error {
  constructor() {
    super('This project has reached the maximum number of subchats.');
    this.name = 'SubchatLimitError';
  }
}

/** An earlier conversation on a GitHub project, kept to read: it refuses work that would change it. */
export class ChatArchivedError extends Error {
  constructor() {
    super('This conversation continues in a newer one. Open the project to keep working.');
    this.name = 'ChatArchivedError';
  }
}
