import { DurableObject } from 'cloudflare:workers';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, ProviderDoc } from '@earendil-works/pi-durable';
import { PiHarness, ROOT_SESSION } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { MODEL_TOOL_INPUT_SCHEMAS } from 'cloudchef-agent/model-tool-inputs';
import { BUILDER_SETTINGS, BuilderChatStream, builderExtension } from '~/agents/builder-pi';
import { CHAT_ENTRY, userEntryData } from '~/agents/builder-chat-view';
import { builderModels } from '~/lib/.server/llm/builder-models';
import { createBuilderTools } from '~/lib/.server/llm/builder-tools';
import {
  contextTokens,
  handoffOpening,
  handoffThresholdTokens,
  hasWorkToHandOff,
  writeHandoffNote,
} from '~/lib/.server/llm/handoff';
import type { ModelHandle } from '~/lib/.server/llm/pi-ai-models';

/** One scripted model response: a command to run, or an answer. */
export type ScriptStep = { command: string; id: string } | { text: string };

/**
 * The builder's pi-durable setup in a Durable Object of its own: `PiHarness` on the object's SQLite, the builder
 * extension (its four tools, here over a fake workspace whose `exec` waits for an approval), pi's settings, the
 * handoff as ConversationAgent runs it, and the chat stream. The model is scripted through RPC.
 */
export class BuilderPiTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider({ models: [{ id: 'small-window', contextWindow: 2_500 }] });
  readonly #handle: ModelHandle = {
    model: this.#faux.getModel(),
    stream: (...[model, context, options]: Parameters<ModelHandle['stream']>) => {
      const { toolChoice: _toolChoice, ...rest } = options ?? {};
      return this.#faux.provider.streamSimple(model, context, rest);
    },
  };
  readonly #models = builderModels(this.#handle);
  readonly #script: ScriptStep[] = [];
  #scripted: (() => void) | null = null;
  #approve: (() => void) | null = null;
  #handoffContinue = false;
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      this.registry.install(
        builderExtension({
          tools: createBuilderTools({
            read: { inputSchema: MODEL_TOOL_INPUT_SCHEMAS.read, execute: async () => ({ content: '' }) },
            write: { inputSchema: MODEL_TOOL_INPUT_SCHEMAS.write, execute: async () => ({ ok: true }) },
            edit: { inputSchema: MODEL_TOOL_INPUT_SCHEMAS.edit, execute: async () => ({ ok: true }) },
            exec: {
              inputSchema: MODEL_TOOL_INPUT_SCHEMAS.exec,
              // A command that changes the account waits in the chat for the person's approval.
              execute: async (input) =>
                new Promise((resolve) => {
                  this.#approve = () => resolve({ ...MODEL_TOOL_INPUT_SCHEMAS.exec.parse(input), exitCode: 0 });
                }),
            },
          }),
          systemPrompt: () => 'You are CloudChef.',
          afterResponse: () => undefined,
          afterTools: async () => {
            this.#handoffContinue = await this.#handOffIfNeeded();
          },
        }),
      );
      return Harness.open(
        storage,
        { models: this.#models.models, registry: this.registry, settings: BUILDER_SETTINGS, onWake },
        context,
      );
    },
    defaults: { model: { provider: this.#models.ref.provider, id: this.#models.ref.modelId } },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);
  readonly chat = new BuilderChatStream({
    harness: () => this.harness.pi(),
    conversation: () => this.harness.conversation(ROOT_SESSION),
    events: () => this.harness.session(ROOT_SESSION).events(),
    send: () => undefined,
  });

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 20 }, () => async () => this.#nextResponse()));
  }

  async #nextResponse() {
    while (this.#script.length === 0) {
      await new Promise<void>((resolve) => {
        this.#scripted = resolve;
      });
    }
    const step = this.#script.shift()!;
    return 'text' in step
      ? fauxAssistantMessage(fauxText(step.text))
      : fauxAssistantMessage(fauxToolCall('exec', { command: step.command }, { id: step.id }), {
          stopReason: 'toolUse',
        });
  }

  script(steps: ScriptStep[]): void {
    this.#script.push(...steps);
    this.#scripted?.();
  }

  approve(): boolean {
    const approve = this.#approve;
    this.#approve = null;
    approve?.();
    return approve !== null;
  }

  async send(text: string): Promise<string> {
    const receipt = await this.harness.submit(text, { entry: { kind: CHAT_ENTRY.user, data: userEntryData(text) } });
    return receipt.operationId;
  }

  /** Waits for the operation, and sends the latest request again after a handoff ended its run, as the agent does. */
  async settle(operationId: string): Promise<string> {
    let result = await this.harness.wait(operationId);
    while (this.#handoffContinue) {
      this.#handoffContinue = false;
      const receipt = await this.harness.submit('Build the todo form', { entry: { kind: CHAT_ENTRY.continued } });
      result = await this.harness.wait(receipt.operationId);
    }
    return result.status;
  }

  async running(): Promise<boolean> {
    return this.#approve !== null;
  }

  /** The chat as JSON: its open-ended parts don't survive RPC's typing. */
  async messages(): Promise<string> {
    return JSON.stringify(await this.chat.messages());
  }

  async modelRequests(): Promise<number> {
    return this.#faux.state.callCount;
  }

  async #handOffIfNeeded(): Promise<boolean> {
    const conversation = await this.harness.conversation(ROOT_SESSION);
    const { messages } = await conversation.context(BACKGROUND_CONTEXT);
    const threshold = handoffThresholdTokens(this.#handle.model.contextWindow, 'step');
    if (!hasWorkToHandOff(messages) || contextTokens(messages) < threshold) {
      return false;
    }
    const provider = await (await this.harness.pi()).snapshot(ProviderDoc, conversation.id, BACKGROUND_CONTEXT);
    const note = await writeHandoffNote({
      handle: this.#handle,
      messages,
      budgetTokens: threshold,
      reasoning: 'off',
      sessionId: provider?.sessionId ?? 'test',
      onUsage: () => undefined,
    });
    await conversation.submit(
      { type: 'write', entry: { kind: CHAT_ENTRY.handoff, data: { note } } },
      BACKGROUND_CONTEXT,
    );
    await conversation.reset(handoffOpening(note), BACKGROUND_CONTEXT);
    return true;
  }
}

export default {
  fetch: () => new Response('Not found', { status: 404 }),
};
