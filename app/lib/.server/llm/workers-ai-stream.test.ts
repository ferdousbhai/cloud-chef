import { describe, expect, it } from 'vitest';
import type { PiStreamChunk } from './pi-stream';
import { normalizeTextPartBoundaries } from './workers-ai-stream';

type UIMessageChunk = PiStreamChunk;

describe('normalizeTextPartBoundaries', () => {
  it('closes a synthesized text part before the terminal chunk', async () => {
    const result = await readChunks(
      normalizeTextPartBoundaries(
        chunks([
          { type: 'start' },
          { type: 'text-delta', id: 'assistant-1', delta: 'Hello' },
          { type: 'finish', finishReason: 'stop' },
        ]),
      ),
    );

    expect(result).toEqual([
      { type: 'start' },
      { type: 'text-start', id: 'assistant-1' },
      { type: 'text-delta', id: 'assistant-1', delta: 'Hello' },
      { type: 'text-end', id: 'assistant-1' },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });

  it('closes an open reasoning part before the terminal chunk', async () => {
    const result = await readChunks(
      normalizeTextPartBoundaries(
        chunks([
          { type: 'start' },
          { type: 'reasoning-start', id: 'think-1' },
          { type: 'reasoning-delta', id: 'think-1', delta: 'Weighing options' },
          { type: 'error', errorText: 'The model request failed. Please retry.' },
        ]),
      ),
    );

    expect(result).toEqual([
      { type: 'start' },
      { type: 'reasoning-start', id: 'think-1' },
      { type: 'reasoning-delta', id: 'think-1', delta: 'Weighing options' },
      { type: 'reasoning-end', id: 'think-1' },
      { type: 'error', errorText: 'The model request failed. Please retry.' },
    ]);
  });

  it('opens a reasoning part for a delta that arrived without its start', async () => {
    const result = await readChunks(
      normalizeTextPartBoundaries(chunks([{ type: 'reasoning-delta', id: 'think-1', delta: 'Mid-thought' }])),
    );

    expect(result).toEqual([
      { type: 'reasoning-start', id: 'think-1' },
      { type: 'reasoning-delta', id: 'think-1', delta: 'Mid-thought' },
      { type: 'reasoning-end', id: 'think-1' },
    ]);
  });
});

function chunks(values: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) {
        controller.enqueue(value);
      }
      controller.close();
    },
  });
}

async function readChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const result: UIMessageChunk[] = [];
  for await (const chunk of stream) {
    result.push(chunk);
  }
  return result;
}
