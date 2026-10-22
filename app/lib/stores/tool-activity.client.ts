import { atom, map } from 'nanostores';
import { getToolInvocation, type CloudChefMessage, type CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { makePartId, type PartId } from 'cloudchef-agent/partId';
import { isToolActivityStatusActive, type ToolActivityStatus } from '~/lib/common/types';

type ToolActivity = {
  invocation: CloudChefToolInvocation;
  status: ToolActivityStatus;
};

export class ToolActivityStore {
  readonly activities = map<Record<PartId, ToolActivity>>({});
  readonly revision = atom(0);
  #scope: string | null = null;
  #turnActive = false;
  #turnHandoffPending = false;

  activateScope(scope: string): void {
    if (this.#scope === scope) {
      return;
    }
    this.#scope = scope;
    if (!this.#turnHandoffPending) {
      this.#turnActive = false;
    }
    this.#turnHandoffPending = false;
    if (Object.keys(this.activities.get()).length > 0) {
      this.activities.set({});
      this.#bumpRevision();
    }
  }

  record(partId: PartId, invocation: CloudChefToolInvocation): void {
    const activities = this.activities.get();
    const current = activities[partId];
    const status = invocationStatus(invocation);
    const settled = !isToolActivityStatusActive(status);
    const terminal = Object.values(activities).find(
      (activity) =>
        activity.invocation.toolCallId === invocation.toolCallId && !isToolActivityStatusActive(activity.status),
    );
    // Stale progress never revives a stopped or finished call; only a settled result can replace it.
    if (terminal && !settled) {
      if (current !== terminal) {
        this.activities.setKey(partId, terminal);
        this.#bumpRevision();
      }
      return;
    }
    if (!this.#turnActive) {
      if (!settled) {
        this.activities.setKey(partId, { invocation, status: 'aborted' });
        this.#bumpRevision();
      } else if (terminal && current?.invocation !== invocation) {
        // A settled result landing after its turn supersedes the one recorded: a publish's build result
        // replaces its pending build, and the server's real result replaces a call shown as stopped.
        this.activities.setKey(partId, { invocation, status });
        this.#bumpRevision();
      }
      return;
    }
    if (current?.invocation === invocation && current.status === status) {
      return;
    }
    this.activities.setKey(partId, { invocation, status });
    this.#bumpRevision();
  }

  startTurn(): void {
    this.#turnActive = true;
  }

  /** Reattach to a server-owned turn without reviving older interrupted tool batches. */
  resumeTurn(message?: CloudChefMessage): void {
    if (this.#turnActive) {
      return;
    }
    this.#turnActive = true;
    if (!message || message.role !== 'assistant') {
      return;
    }
    const resumableIds = new Set<string>();
    for (const part of message.parts.toReversed()) {
      const invocation = getToolInvocation(part);
      if (!invocation) {
        break;
      }
      resumableIds.add(invocation.toolCallId);
    }
    for (const part of message.parts) {
      const invocation = getToolInvocation(part);
      if (invocation && invocationStatus(invocation) === 'complete') {
        resumableIds.add(invocation.toolCallId);
      }
    }
    const activities = this.activities.get();
    this.activities.set(
      Object.fromEntries(
        Object.entries(activities).filter(
          ([, activity]) => activity.status !== 'aborted' || !resumableIds.has(activity.invocation.toolCallId),
        ),
      ),
    );
    message.parts.forEach((part, index) => {
      const invocation = getToolInvocation(part);
      if (invocation) {
        const partId = makePartId(message.id, index);
        if (resumableIds.has(invocation.toolCallId)) {
          this.record(partId, invocation);
        } else if (!this.activities.get()[partId]) {
          this.activities.setKey(partId, { invocation, status: 'aborted' });
        }
      }
    });
    this.#bumpRevision();
  }

  handoffActiveTurn(): void {
    this.#turnHandoffPending = this.#turnActive;
  }

  finishTurn(message: CloudChefMessage): void {
    message.parts?.forEach((part, index) => {
      const invocation = getToolInvocation(part);
      if (invocation) {
        this.record(makePartId(message.id, index), invocation);
      }
    });
    this.abortActive();
  }

  abortActive(): void {
    this.#turnActive = false;
    this.#turnHandoffPending = false;
    let changed = false;
    // SAFETY: every key in this map was written through `setKey(partId, ...)`, so the entries are
    // PartId-keyed; `Object.entries` only widens the branded key back to `string`.
    for (const [partId, activity] of Object.entries(this.activities.get()) as Array<[PartId, ToolActivity]>) {
      if (!isToolActivityStatusActive(activity.status)) {
        continue;
      }
      this.activities.setKey(partId, { ...activity, status: 'aborted' });
      changed = true;
    }
    if (changed) {
      this.#bumpRevision();
    }
  }

  #bumpRevision(): void {
    this.revision.set(this.revision.get() + 1);
  }
}

export function invocationStatus(invocation: CloudChefToolInvocation): ToolActivityStatus {
  switch (invocation.state) {
    case 'input-streaming':
      return 'pending';
    case 'input-available':
      return 'running';
    case 'output-available':
    case 'output-error':
      return 'complete';
  }
  throw new Error(`Unsupported tool invocation state: ${invocation.state}`);
}

export const toolActivityStore = new ToolActivityStore();
