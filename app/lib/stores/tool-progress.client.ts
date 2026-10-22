import { map } from 'nanostores';

type ToolProgress = {
  toolCallId: string;
  toolName: string;
  result: unknown;
};

class ToolProgressStore {
  readonly progress = map<Record<string, ToolProgress>>({});

  record(value: ToolProgress): void {
    this.progress.setKey(value.toolCallId, value);
  }

  clear(): void {
    if (Object.keys(this.progress.get()).length === 0) {
      return;
    }
    this.progress.set({});
  }
}

export const toolProgressStore = new ToolProgressStore();
