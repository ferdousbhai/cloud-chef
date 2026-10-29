import { createModels, createProvider, type Models } from '@earendil-works/pi-ai/models';
import type { ModelRef } from '@earendil-works/pi-durable';
import type { ModelHandle } from './pi-ai-models';

/**
 * One builder model as pi-ai `Models`, for pi-durable's generation: a provider that holds only that model and
 * streams it through `getPiModel`'s handle (the Workers AI binding, or a provider's model through the account's AI
 * Gateway). Auth is the handle's own, so the provider resolves none. Built per turn, so the turn's gateway logging
 * and key revision apply to every request it makes.
 */
export function builderModels(handle: ModelHandle) {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: handle.model.provider,
      auth: { apiKey: { name: 'CloudChef', resolve: async () => ({ auth: {} }) } },
      models: [handle.model],
      api: {
        stream: (model, context, options) => handle.stream(model, context, options),
        // The request's own output ceiling is worked out per request in the handle, from what the model's window has
        // left: asking for the model's whole window leaves that to it.
        streamSimple: (model, context, options) =>
          handle.stream(model, context, { ...options, maxTokens: options?.maxTokens ?? model.maxTokens }),
      },
    }),
  );
  const ref: ModelRef = { provider: handle.model.provider, modelId: handle.model.id };
  const builder: Models = models;
  return { models: builder, ref };
}
