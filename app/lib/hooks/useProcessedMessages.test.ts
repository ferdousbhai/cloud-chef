// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { CloudChefMessage, CloudChefPart } from 'cloudchef-agent/ai-compat';
import { makePartId } from 'cloudchef-agent/partId';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { processMessage, useProcessedMessages, type PartCache } from './useProcessedMessages';

describe('useProcessedMessages', () => {
  it("records a reloaded chat's interrupted calls as stopped once its scope is active, and reads stored ones it does not know", () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const stored: CloudChefMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        { type: 'dynamic-tool', toolName: 'exec', toolCallId: 'exec-1', state: 'output-denied', input: {} },
        { type: 'dynamic-tool', toolName: 'write', toolCallId: 'write-1', state: 'input-available', input: {} },
      ],
    };
    let rendered: CloudChefMessage[] = [];
    function Reloaded() {
      const { parsedMessages, processMessages } = useProcessedMessages();
      useEffect(() => {
        toolActivityStore.activateScope('reloaded-chat');
        processMessages([stored]);
      }, [processMessages]);
      rendered = parsedMessages;
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Reloaded)));

    expect(rendered).toEqual([stored]);
    expect(toolActivityStore.activities.get()).toEqual({
      [makePartId('assistant-1', 1)]: {
        invocation: expect.objectContaining({ toolCallId: 'write-1' }),
        status: 'aborted',
      },
    });
    act(() => root.unmount());
  });
});

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
      type: 'dynamic-tool',
      toolName: 'publish_preview',
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

  it("serializes the cached part's settled output once across updates", () => {
    const settled: CloudChefPart = {
      type: 'dynamic-tool',
      toolName: 'exec',
      toolCallId: 'exec-1',
      state: 'output-available',
      input: {},
      output: { ok: true, stdout: 'x'.repeat(10_000) },
    };
    const cache: PartCache = new Map();
    processMessage({ id: 'assistant-1', role: 'assistant', parts: [settled] }, cache);
    const stringify = vi.spyOn(JSON, 'stringify');

    for (let update = 0; update < 3; update++) {
      const reparsed = processMessage(
        { id: 'assistant-1', role: 'assistant', parts: [structuredClone(settled)] },
        cache,
      );
      expect(reparsed.parts[0]).toBe(settled);
    }

    expect(stringify.mock.calls.filter(([value]) => value === settled.output)).toHaveLength(1);
    stringify.mockRestore();
  });
});
