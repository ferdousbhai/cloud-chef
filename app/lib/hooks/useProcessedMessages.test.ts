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

  it("shows a settled call's output replaced in place after its turn, and keeps an equal one", () => {
    const pending: CloudChefPart = {
      type: 'tool-publish_preview',
      toolCallId: 'publish-1',
      state: 'output-available',
      input: {},
      output: { ok: true, summary: 'Building', data: { build: 'pending' } },
    };
    const built: CloudChefPart = { ...pending, output: { ok: true, summary: 'Built', data: { build: 'success' } } };
    const cache: PartCache = new Map();
    processMessage({ id: 'assistant-1', role: 'assistant', parts: [pending] }, cache);

    const reparsed = processMessage({ id: 'assistant-1', role: 'assistant', parts: [structuredClone(pending)] }, cache);
    expect(reparsed.parts[0]).toBe(pending);
    const landed = processMessage({ id: 'assistant-1', role: 'assistant', parts: [built] }, cache);
    expect(landed.parts[0]).toBe(built);
  });
});
