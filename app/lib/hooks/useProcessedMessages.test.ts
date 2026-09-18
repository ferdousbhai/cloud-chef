import { describe, expect, it } from 'vitest';
import type { CloudChefMessage, CloudChefPart } from 'cloudchef-agent/ai-compat';
import { makePartId } from 'cloudchef-agent/partId';
import { processMessage, type PartCache } from './useProcessedMessages';

describe('processMessage', () => {
  it('replaces an incomplete recovered tool part without reading a missing state', () => {
    const incomplete = {
      type: 'dynamic-tool',
      toolName: 'write',
      toolCallId: 'write-1',
      input: {},
    } as CloudChefPart;
    const completed = {
      ...incomplete,
      state: 'output-available',
      output: { ok: true },
    } as CloudChefPart;
    const cache: PartCache = new Map([[makePartId('assistant-1', 0), incomplete]]);
    const message: CloudChefMessage = { id: 'assistant-1', role: 'assistant', parts: [completed] };

    expect(processMessage(message, cache)).toEqual(message);
  });
});
