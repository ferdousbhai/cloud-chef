import { describe, expect, it } from 'vitest';
import type { GhostbuildMessage, GhostbuildPart } from 'ghostbuild-agent/ai-compat';
import { makePartId } from 'ghostbuild-agent/partId';
import { processMessage, type PartCache } from './useProcessedMessages';

describe('processMessage', () => {
  it('replaces an incomplete recovered tool part without reading a missing state', () => {
    const incomplete = {
      type: 'dynamic-tool',
      toolName: 'write',
      toolCallId: 'write-1',
      input: {},
    } as GhostbuildPart;
    const completed = {
      ...incomplete,
      state: 'output-available',
      output: { ok: true },
    } as GhostbuildPart;
    const cache: PartCache = new Map([[makePartId('assistant-1', 0), incomplete]]);
    const message: GhostbuildMessage = { id: 'assistant-1', role: 'assistant', parts: [completed] };

    expect(processMessage(message, cache)).toEqual(message);
  });
});
