export type PiStreamChunk =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string; dynamic?: boolean }
  | { type: 'tool-input-delta'; toolCallId: string; inputTextDelta: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown; dynamic?: boolean }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown; dynamic?: boolean }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string; dynamic?: boolean }
  | {
      type: 'data-tool-progress';
      id: string;
      data: { toolCallId: string; toolName: string; result: unknown };
      transient: true;
    }
  | { type: 'finish'; finishReason: 'stop' | 'error' | 'tool-calls' | 'length' }
  | { type: 'error'; errorText: string }
  | { type: 'start' };

/**
 * Text and reasoning both arrive as provider-framed parts, and a provider that ends a turn mid-part
 * would otherwise leave the client rendering an assistant bubble that never closes. Every open part
 * is closed before the terminal chunk and again at flush, and a delta that arrives without its start
 * opens the part it belongs to.
 */
export function normalizeTextPartBoundaries(stream: ReadableStream<PiStreamChunk>): ReadableStream<PiStreamChunk> {
  const openTextPartIds = new Set<string>();
  const openReasoningPartIds = new Set<string>();
  const closeOpenParts = (controller: TransformStreamDefaultController<PiStreamChunk>) => {
    for (const id of openTextPartIds) {
      controller.enqueue({ type: 'text-end', id });
    }
    openTextPartIds.clear();
    for (const id of openReasoningPartIds) {
      controller.enqueue({ type: 'reasoning-end', id });
    }
    openReasoningPartIds.clear();
  };
  return stream.pipeThrough(
    new TransformStream<PiStreamChunk, PiStreamChunk>({
      transform(chunk, controller) {
        switch (chunk.type) {
          case 'text-start':
            openTextPartIds.add(chunk.id);
            controller.enqueue(chunk);
            return;
          case 'text-delta':
            if (!openTextPartIds.has(chunk.id)) {
              openTextPartIds.add(chunk.id);
              controller.enqueue({ type: 'text-start', id: chunk.id });
            }
            controller.enqueue(chunk);
            return;
          case 'text-end':
            if (!openTextPartIds.has(chunk.id)) {
              controller.enqueue({ type: 'text-start', id: chunk.id });
            }
            controller.enqueue(chunk);
            openTextPartIds.delete(chunk.id);
            return;
          case 'reasoning-start':
            openReasoningPartIds.add(chunk.id);
            controller.enqueue(chunk);
            return;
          case 'reasoning-delta':
            if (!openReasoningPartIds.has(chunk.id)) {
              openReasoningPartIds.add(chunk.id);
              controller.enqueue({ type: 'reasoning-start', id: chunk.id });
            }
            controller.enqueue(chunk);
            return;
          case 'reasoning-end':
            if (!openReasoningPartIds.has(chunk.id)) {
              controller.enqueue({ type: 'reasoning-start', id: chunk.id });
            }
            controller.enqueue(chunk);
            openReasoningPartIds.delete(chunk.id);
            return;
          default:
            if (chunk.type === 'finish' || chunk.type === 'error') {
              closeOpenParts(controller);
            }
            controller.enqueue(chunk);
        }
      },
      flush(controller) {
        closeOpenParts(controller);
      },
    }),
  );
}
