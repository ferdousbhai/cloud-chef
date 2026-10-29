import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  GenerationTask,
  hook,
  LiveDoc,
  type AgentEventStream,
  type Conversation,
  type EntryRecord,
  type Extension,
  type Harness,
  type HarnessSettings,
  type LiveState,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { CHAT_FRAME_TYPE, chatFrameChange, type ChatFrame } from 'cloudchef-agent/chat-frame';
import { CHAT_ENTRY, chatMessages, liveToolProgress } from './builder-chat-view';

/** The builder's one extension: its four tools, the system prompt, and the hooks CloudChef keeps. */
const BUILDER_EXTENSION_NAME = 'cloudchef';

export function builderExtension(args: {
  tools: readonly ToolRegistration[];
  /** The system prompt: one section, describing the environment. */
  systemPrompt: () => string | Promise<string>;
  /** Every model response, for the organization's per-member usage. */
  afterResponse: (message: AssistantMessage) => void;
  /** After each round of tool calls: hands off when the context has grown near the model's limit. */
  afterTools: () => Promise<void>;
}): Extension {
  return {
    name: BUILDER_EXTENSION_NAME,
    tools: args.tools,
    sections: [{ key: 'cloudchef', render: () => args.systemPrompt(), tag: false }],
    hooks: [
      hook(GenerationTask, {
        afterResponse: (message) => args.afterResponse(message),
        afterTools: () => args.afterTools(),
      }),
    ],
  };
}

/**
 * Run policy. No compaction: a context fills the model's window and hands off near its limit, and prompt caching
 * covers the cost of the long prefix. Inputs the person queued behind a run that failed start the next run.
 */
export const BUILDER_SETTINGS: HarnessSettings = {
  compaction: { enabled: false },
  afterFailedRun: 'continue',
};

/** What the chat stream reads and where it sends frames. */
type ChatStreamSource = {
  harness: () => Promise<Harness>;
  conversation: () => Promise<Conversation>;
  events: () => Promise<AgentEventStream>;
  send: (frame: string) => void;
  /** Called on each commit to the conversation, for the turn's inactivity watch. */
  onActivity?: () => void;
};

/** How long the stream waits after a commit before it sends, so a burst of commits goes as one frame. */
const CHAT_FRAME_DELAY_MS = 50;
const ENTRY_PAGE_SIZE = 500;

/**
 * The chat as the browser sees it, kept in step with the conversation: every entry from the first (read once, then
 * only what each commit adds), and `pi.live`. Each commit pi-durable's event stream reports schedules one frame with
 * what changed, sent to every connected browser.
 */
export class BuilderChatStream {
  readonly #source: ChatStreamSource;
  #entries: EntryRecord[] = [];
  #live: Readonly<LiveState> | undefined;
  #sent: CloudChefMessage[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushing: Promise<void> | null = null;
  #dirty = false;
  #started: Promise<void> | null = null;
  #stream: AgentEventStream | null = null;
  #overrideSeen = false;
  #sentBusy = false;

  constructor(source: ChatStreamSource) {
    this.#source = source;
  }

  /** Reads the chat and follows the conversation's commits; once, however often it is called. */
  start(): Promise<void> {
    if (this.#started) {
      return this.#started;
    }
    const starting = (async () => {
      await this.#readNew();
      this.#sent = this.#derive();
      this.#sentBusy = this.busy();
      const stream = await this.#source.events();
      this.#stream = stream;
      stream.start(async () => {
        this.#source.onActivity?.();
        this.#schedule();
      });
      // A commit between the first read and the subscription is read now.
      this.#schedule();
      void stream.closed.then(() => {
        // pi closed (a storage error, or the object is going away): the next call starts the stream again.
        if (this.#stream === stream) {
          this.#stream = null;
          this.#started = null;
        }
      });
    })();
    this.#started = starting;
    // A start that failed is tried again by the next call.
    starting.catch(() => {
      if (this.#started === starting) {
        this.#started = null;
      }
    });
    return starting;
  }

  /** The chat's messages as of the last read. */
  async messages(): Promise<CloudChefMessage[]> {
    await this.start();
    await this.#flush();
    return this.#sent;
  }

  /** Whether a tool call is running, as of the last read: a tool keeps its own deadline. */
  toolRunning(): boolean {
    return (this.#live?.tools ?? []).some((slot) => slot.status === 'running');
  }

  /** Whether a run is going, as of the last read. */
  busy(): boolean {
    return this.#live?.run !== undefined;
  }

  /** The whole chat, for a browser that just connected. */
  async snapshotFrame(): Promise<string> {
    const messages = await this.messages();
    return JSON.stringify(this.#frame({ from: 0, keepParts: 0, messages }));
  }

  /** Read again now, and send what changed. */
  refresh(): Promise<void> {
    this.#dirty = true;
    return this.#flush();
  }

  async stop(): Promise<void> {
    clearTimeout(this.#timer);
    const stream = this.#stream;
    this.#stream = null;
    this.#started = null;
    await stream?.stop();
  }

  #schedule(): void {
    this.#dirty = true;
    if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.#flush().catch(() => undefined);
      }, CHAT_FRAME_DELAY_MS);
    }
  }

  async #flush(): Promise<void> {
    while (this.#flushing) {
      await this.#flushing;
    }
    if (!this.#dirty) {
      return;
    }
    this.#dirty = false;
    this.#flushing = (async () => {
      const before = this.#entries.length;
      await this.#readNew();
      const next = this.#derive();
      // Only a newer output of a finished call changes a message before the last two; otherwise compare the tail.
      const compareFrom = this.#overrideSeen ? 0 : Math.max(0, Math.min(this.#sent.length, next.length) - 2);
      this.#overrideSeen = false;
      const change = chatFrameChange(this.#sent, next, before === 0 ? 0 : compareFrom);
      const progressChanged = liveToolProgress(this.#live).length > 0;
      const busyChanged = this.#sentBusy !== this.busy();
      this.#sent = next;
      this.#sentBusy = this.busy();
      if (change || progressChanged || busyChanged) {
        this.#source.send(JSON.stringify(this.#frame(change ?? { from: next.length, keepParts: 0, messages: [] })));
      }
    })();
    try {
      await this.#flushing;
    } finally {
      this.#flushing = null;
    }
  }

  async #readNew(): Promise<void> {
    const conversation = await this.#source.conversation();
    const last = this.#entries.at(-1)?.id;
    let cursor: Parameters<Conversation['entries']>[2];
    do {
      const page = await conversation.entries(
        last === undefined ? { order: 'ascending' } : { order: 'ascending', minEntryId: last },
        ENTRY_PAGE_SIZE,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items) {
        if (last === undefined || entry.id > last) {
          this.#entries.push(entry);
          if (entry.kind === CHAT_ENTRY.toolOutput) {
            this.#overrideSeen = true;
          }
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    const harness = await this.#source.harness();
    this.#live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
  }

  #derive(): CloudChefMessage[] {
    return chatMessages(this.#entries, this.#live);
  }

  #frame(change: { from: number; keepParts: number; messages: CloudChefMessage[] }): ChatFrame {
    return {
      type: CHAT_FRAME_TYPE,
      ...change,
      busy: this.busy(),
      progress: liveToolProgress(this.#live),
    };
  }
}
