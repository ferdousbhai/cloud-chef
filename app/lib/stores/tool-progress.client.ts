import { atom, map } from 'nanostores';

type ToolProgress = {
  toolCallId: string;
  toolName: string;
  result: unknown;
};

class ToolProgressStore {
  readonly progress = map<Record<string, ToolProgress>>({});
  readonly revision = atom(0);

  record(value: ToolProgress): void {
    this.progress.setKey(value.toolCallId, value);
    this.#bumpRevision();
  }

  clear(): void {
    if (Object.keys(this.progress.get()).length === 0) {
      return;
    }
    this.progress.set({});
    this.#bumpRevision();
  }

  #bumpRevision(): void {
    this.revision.set(this.revision.get() + 1);
  }
}

export const toolProgressStore = new ToolProgressStore();
